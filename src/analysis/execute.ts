import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, DocumentRecord } from '../runner/db';
import { rawKey } from '../runner/db';
import { makeTask } from '../tasks/make';
import { parseItems } from '../tasks/parse';
import { runTask } from '../runner/runTask';
import { makeCallModel } from '../runner/callModel';
import { ACTIVE_STATUSES, type CallRequest, type CallResult, type ResultRow, type RunConfig, type Task } from '../tasks/types';
import { estimateCost, BUDGET_FACTOR, MAX_BUDGET_TOKENS, MIN_BUDGET_TOKENS, CONCURRENCY } from './config';
import type { AnalysisMetrics } from './types';

// Failures that mean the provider or network is struggling; all workers pause for them.
const RATE_LIMIT_CODES = (code: string | null | undefined) =>
  code === 'http_429' || code === 'network' || code === 'timeout' || (typeof code === 'string' && /^http_5\d\d$/.test(code));

// One shared pause for every worker, so concurrent tasks do not all retry at the same moment.
export function createBackoffGate() {
  let until = 0;
  return {
    hold(ms: number) {
      until = Math.max(until, Date.now() + ms);
    },
    async wait(taskNextAt: number) {
      const delay = Math.max(until, taskNextAt) - Date.now();
      if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay + Math.random() * 250));
    },
  };
}

export interface ExecuteContext {
  db: HarnessDBHandle;
  supabase: SupabaseClient;
  accessToken: string;
  refreshAccessToken?: (force?: boolean) => Promise<string | null>;
  userId?: string | null;
  functionsUrl: string;
  anonKey: string;
  model: string;
  fallbackModel: string | null;
  reasoning?: { effort: 'minimal' | 'low' | 'medium' | 'high' } | null;
  timeoutMs: number;
  onLog?: (line: string) => void;
  // Abort scheduling when the failed share of completed tasks passes this value.
  maxFailureRate?: number;
  // Reduce worker concurrency after repeated http_429 responses.
  autoReduceConcurrency?: boolean;
  // Stop the pass and pause the run after this many consecutive 429 responses.
  maxConsecutive429?: number;
  // Test hook: replace the proxy call without changing the runner.
  callModel?: (req: CallRequest) => Promise<CallResult>;
}

export interface TaskPlan {
  suffix: string;
  promptVersion: string;
  prompt: string;
  input: string;
  maxTokens: number;
  delayMs?: number;
  validate: (item: unknown) => boolean;
}

export interface ExecuteResult {
  runId: string;
  collected: { taskId: string; items: unknown[] }[];
  tasks: Task[];
  failed: number;
  aborted: boolean;
  rateLimitEvents: number;
  rateLimitWaitMs: number;
  concurrency: number;
  pausedReason: 'rate_limited' | null;
  pausedRetryAfterMs: number;
}

export async function createRun(ctx: ExecuteContext, doc: DocumentRecord): Promise<string> {
  const runId = crypto.randomUUID();
  const { error } = await ctx.supabase.from('runs').insert({
    id: runId,
    user_id: ctx.userId ?? null,
    doc_hash: doc.hash,
    prep_fingerprint: doc.prepFingerprint,
    status: 'running',
  });
  if (error) throw error;
  return runId;
}

export function makeRunConfig(ctx: ExecuteContext): RunConfig {
  return {
    callModel:
      ctx.callModel ??
      makeCallModel({
        functionsUrl: ctx.functionsUrl,
        anonKey: ctx.anonKey,
        accessToken: ctx.accessToken,
        refreshToken: ctx.refreshAccessToken,
      }),
    saveResult: async (row: ResultRow) => {
      const { error } = await ctx.supabase.rpc('save_task_result', { p_row: row });
      if (error) throw error;
    },
    validateItem: () => true,
    model: ctx.model,
    fallbackModel: ctx.fallbackModel,
    timeoutMs: ctx.timeoutMs,
    reasoning: ctx.reasoning ?? null,
    maxRetries: 3,
    minPieceChars: 800,
    maxSplitDepth: 4,
    backoffMs: (n) => Math.min(30_000, 2_000 * 2 ** (n - 1)),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };
}

// Runs a set of tasks through runTask, collecting validated payload items per task.
export async function executeTasks(
  ctx: ExecuteContext,
  runId: string,
  doc: DocumentRecord,
  plans: TaskPlan[],
): Promise<ExecuteResult> {
  const cfg = makeRunConfig(ctx);
  const collected: { taskId: string; items: unknown[] }[] = [];
  const bySuffix = new Map<string, TaskPlan>();

  const now = Date.now();
  for (const plan of plans) {
    bySuffix.set(plan.suffix, plan);
    const id = `${runId}:${plan.suffix}`;
    const existing = await ctx.db.get('tasks', id);
    if (existing) {
      // Resume: finished work is reused, paused/queued work is left for the runner below.
      if (existing.status === 'done' && existing.attemptId) {
        const raw = await ctx.db.get('raw_responses', rawKey(id, existing.attemptId));
        if (raw) {
          const parsed = parseItems(raw.text, plan.validate);
          if ('items' in parsed && parsed.items.length) collected.push({ taskId: id, items: parsed.items });
        }
      }
      continue;
    }
    const task = await makeTask(
      {
        id,
        runId,
        parentId: null,
        depth: 0,
        docHash: doc.hash,
        prepFingerprint: doc.prepFingerprint!,
        promptVersion: plan.promptVersion,
        prompt: plan.prompt,
        input: plan.input,
        maxTokens: plan.maxTokens,
      },
      now,
    );
    if (plan.delayMs && plan.delayMs > 0) await ctx.db.put('tasks', { ...task, nextAt: now + plan.delayMs });
    else await ctx.db.put('tasks', task);
  }

  const originalSave = cfg.saveResult;
  cfg.saveResult = async (row: ResultRow) => {
    await originalSave(row);
    const payload = row.payload as { items?: unknown[] } | null;
    if (payload?.items) {
      const baseTaskId = row.task_id.split('/')[0];
      const plan = bySuffix.get(baseTaskId.slice(baseTaskId.lastIndexOf(':') + 1));
      const items = payload.items.filter((i) => (plan ? plan.validate(i) : true));
      if (items.length) collected.push({ taskId: row.task_id, items });
    }
  };

  const gate = createBackoffGate();
  let processed = 0;
  let failedSoFar = 0;
  let aborted = false;
  let rateLimitEvents = 0;
  let rateLimitWaitMs = 0;
  let concurrency = CONCURRENCY;
  let recent429: number[] = [];
  let pausedReason: 'rate_limited' | null = null;
  let pausedRetryAfterMs = 0;
  const maxConsecutive429 = ctx.maxConsecutive429 ?? 10;
  for (let round = 0; round < 60; round++) {
    const all = await ctx.db.getAllFromIndex('tasks', 'byRun', runId);
    const active = all.filter((t) => ACTIVE_STATUSES.includes(t.status));
    if (active.length === 0) break;
    // Each task id is claimed once per round, so no task runs in two workers at once.
    const queue = active.map((t) => t.id);
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (aborted) break;
        const fresh = await ctx.db.get('tasks', id);
        if (!fresh || !ACTIVE_STATUSES.includes(fresh.status)) continue;
        await gate.wait(fresh.nextAt);
        const outcome = await runTask(ctx.db, fresh, cfg);
        if (outcome !== 'rate_limited') processed++;
        if (outcome === 'failed') failedSoFar++;
        if (ctx.maxFailureRate !== undefined && processed >= 10 && failedSoFar / processed > ctx.maxFailureRate) {
          aborted = true;
          ctx.onLog?.(
            `abort: ${failedSoFar} failed of ${processed} completed tasks (${((failedSoFar / processed) * 100).toFixed(0)}% > ${(ctx.maxFailureRate * 100).toFixed(0)}%)`,
          );
        }
        const after = await ctx.db.get('tasks', id);
        if (after?.failureCode === 'http_429') {
          rateLimitEvents++;
          const nowMs = Date.now();
          const wait = Math.max(1000, (after.nextAt ?? nowMs) - nowMs);
          rateLimitWaitMs += wait;
          recent429.push(nowMs);
          recent429 = recent429.filter((t) => nowMs - t <= 60_000);
          if (ctx.autoReduceConcurrency && recent429.length % 3 === 0 && concurrency > 1) {
            concurrency--;
            ctx.onLog?.(`concurrency reduced to ${concurrency} after repeated http_429`);
          }
          if (recent429.length >= maxConsecutive429) {
            pausedReason = 'rate_limited';
            pausedRetryAfterMs = wait;
            aborted = true;
            ctx.onLog?.(
              `paused: rate limited after ${recent429.length} 429s in 60s (retry in ${Math.ceil(wait / 1000)}s)`,
            );
          }
          gate.hold(wait);
        }
        ctx.onLog?.(`${fresh.id.slice(-14)}: ${outcome}${after?.failureCode ? `:${after.failureCode}` : ''}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    if (aborted) break;
  }

  const tasks = await ctx.db.getAllFromIndex('tasks', 'byRun', runId);
  return {
    runId,
    collected,
    tasks,
    failed: tasks.filter((t) => t.status === 'failed').length,
    aborted,
    rateLimitEvents,
    rateLimitWaitMs,
    concurrency,
    pausedReason,
    pausedRetryAfterMs,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// Metrics come from the raw responses (one per actual provider call), so retried and
// failed attempts are counted as real calls.
export async function computeMetrics(db: HarnessDBHandle, tasks: Task[]): Promise<AnalysisMetrics> {
  const ids = new Set(tasks.map((t) => t.id));
  const raws = (await db.getAll('raw_responses')).filter((r) => ids.has(r.taskId.split('/')[0]));
  const durations = raws.map((r) => r.durationMs).filter((d) => Number.isFinite(d) && d > 0);
  const completion = raws.map((r) => r.completionTokens ?? 0);
  const promptTokens = raws.reduce((n, r) => n + (r.promptTokens ?? 0), 0);
  const completionTokens = raws.reduce((n, r) => n + (r.completionTokens ?? 0), 0);

  const p95CompletionTokens = percentile(completion.filter((n) => n > 0), 95);
  const recommended = p95CompletionTokens
    ? Math.max(MIN_BUDGET_TOKENS, Math.min(MAX_BUDGET_TOKENS, Math.round(p95CompletionTokens * BUDGET_FACTOR)))
    : null;

  return {
    calls: raws.length,
    promptTokens,
    completionTokens,
    costUsd: estimateCost(promptTokens, completionTokens),
    p95DurationMs: percentile(durations, 95),
    retried: tasks.filter((t) => t.attemptNo > 1).length,
    split: tasks.filter((t) => t.status === 'split').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    emptyOutput: tasks.filter((t) => t.failureCode === 'empty_output').length,
    totalTasks: tasks.length,
    doneTasks: tasks.filter((t) => t.status === 'done').length,
    p95CompletionTokens,
    recommendedMaxTokens: recommended,
  };
}
