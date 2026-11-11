import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, DocumentRecord } from '../runner/db';
import { makeTask } from '../tasks/make';
import { runTask } from '../runner/runTask';
import { makeCallModel } from '../runner/callModel';
import { ACTIVE_STATUSES, type ResultRow, type RunConfig, type Task } from '../tasks/types';
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
  userId?: string | null;
  functionsUrl: string;
  anonKey: string;
  model: string;
  fallbackModel: string | null;
  reasoning?: { effort: 'minimal' | 'low' | 'medium' | 'high' } | null;
  timeoutMs: number;
  onLog?: (line: string) => void;
}

export interface TaskPlan {
  suffix: string;
  promptVersion: string;
  prompt: string;
  input: string;
  maxTokens: number;
  validate: (item: unknown) => boolean;
}

export interface ExecuteResult {
  runId: string;
  collected: { taskId: string; items: unknown[] }[];
  tasks: Task[];
  failed: number;
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
    callModel: makeCallModel({ functionsUrl: ctx.functionsUrl, anonKey: ctx.anonKey, accessToken: ctx.accessToken }),
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
    const task = await makeTask(
      {
        id: `${runId}:${plan.suffix}`,
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
    await ctx.db.put('tasks', task);
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
  for (let round = 0; round < 60; round++) {
    const all = await ctx.db.getAllFromIndex('tasks', 'byRun', runId);
    const active = all.filter((t) => ACTIVE_STATUSES.includes(t.status));
    if (active.length === 0) break;
    // Each task id is claimed once per round, so no task runs in two workers at once.
    const queue = active.map((t) => t.id);
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const fresh = await ctx.db.get('tasks', id);
        if (!fresh || !ACTIVE_STATUSES.includes(fresh.status)) continue;
        await gate.wait(fresh.nextAt);
        const outcome = await runTask(ctx.db, fresh, cfg);
        const after = await ctx.db.get('tasks', id);
        if (after && ACTIVE_STATUSES.includes(after.status) && RATE_LIMIT_CODES(after.failureCode)) {
          gate.hold(cfg.backoffMs(after.attemptNo));
        }
        ctx.onLog?.(`${fresh.id.slice(-14)}: ${outcome}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  }

  const tasks = await ctx.db.getAllFromIndex('tasks', 'byRun', runId);
  return { runId, collected, tasks, failed: tasks.filter((t) => t.status === 'failed').length };
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
