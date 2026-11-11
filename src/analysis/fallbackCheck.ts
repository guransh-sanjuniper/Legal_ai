import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, DocumentRecord } from '../runner/db';
import { makeTask } from '../tasks/make';
import { runTask } from '../runner/runTask';
import { makeCallModel } from '../runner/callModel';
import { CallError, type ResultRow, type Task } from '../tasks/types';
import { createRun, makeRunConfig, type ExecuteContext } from './execute';

export interface CheckContext {
  db: HarnessDBHandle;
  supabase: SupabaseClient;
  accessToken: string;
  userId?: string | null;
  functionsUrl: string;
  anonKey: string;
  model: string;
  fallbackModel: string | null;
}

export interface FallbackCheckResult {
  pass: boolean;
  detail: string;
  task: Task | null;
  resultRows: number;
  rawResponses: number;
}

const CHECK_PROMPT = 'Return ONLY the JSON array [{"ok":true}] and nothing else.';
const CHECK_INPUT = 'Ping.';

async function seedTask(ctx: CheckContext, doc: DocumentRecord, runId: string, maxTokens: number): Promise<Task> {
  const task = await makeTask(
    {
      id: `${runId}:chk`,
      runId,
      parentId: null,
      depth: 0,
      docHash: doc.hash,
      prepFingerprint: doc.prepFingerprint!,
      promptVersion: 'fallback-check-v1',
      prompt: CHECK_PROMPT,
      input: CHECK_INPUT,
      maxTokens,
    },
    Date.now(),
  );
  await ctx.db.put('tasks', task);
  return task;
}

async function countRows(ctx: CheckContext, runId: string): Promise<{ rows: number; raws: number }> {
  const { count } = await ctx.supabase.from('task_results').select('*', { count: 'exact', head: true }).eq('run_id', runId);
  const tasks = await ctx.db.getAllFromIndex('tasks', 'byRun', runId);
  const raws = (await ctx.db.getAll('raw_responses')).filter((r) => tasks.some((t) => r.taskId.startsWith(t.id))).length;
  return { rows: count ?? 0, raws };
}

// Forces the first three attempts to fail with a transient network error, so attempt 4
// must use the fallback model. Asserts exactly one saved result row and one raw response.
export async function runFallbackCheck(ctx: CheckContext, doc: DocumentRecord): Promise<FallbackCheckResult> {
  if (!ctx.fallbackModel) {
    return { pass: false, detail: 'VITE_FALLBACK_MODEL is not set', task: null, resultRows: 0, rawResponses: 0 };
  }
  const exec: ExecuteContext = { ...ctx, timeoutMs: 30_000, reasoning: null };
  const runId = await createRun(exec, doc);
  const task = await seedTask(ctx, doc, runId, 80);

  const cfg = makeRunConfig(exec);
  const real = cfg.callModel;
  let calls = 0;
  cfg.callModel = async (req) => {
    calls++;
    if (calls <= 3) throw new CallError('network');
    return real(req);
  };

  // Drive the task through its retry backoff until it is terminal.
  let outcome = '';
  for (let round = 0; round < 8; round++) {
    const fresh = (await ctx.db.get('tasks', task.id))!;
    if (fresh.status !== 'queued' && fresh.status !== 'retry_wait' && fresh.status !== 'uncertain') break;
    const wait = Math.max(0, fresh.nextAt - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait + 50));
    outcome = await runTask(ctx.db, (await ctx.db.get('tasks', task.id))!, cfg);
  }
  const final = (await ctx.db.get('tasks', task.id))!;
  const { rows, raws } = await countRows(ctx, runId);

  const pass =
    (final.status === 'done') &&
    final.attemptNo === 4 &&
    final.model === ctx.fallbackModel &&
    rows === 1 &&
    raws === 1;

  return {
    pass,
    detail: `outcome=${outcome}, attempts=${final.attemptNo}, model=${final.model}, result_rows=${rows}, raw_responses=${raws}`,
    task: final,
    resultRows: rows,
    rawResponses: raws,
  };
}

// Uses an invalid model id to produce a non-retryable failure, which must show up in the
// failed-task table with its failure code.
export async function runForcedFailure(ctx: CheckContext, doc: DocumentRecord): Promise<{ pass: boolean; detail: string; task: Task | null }> {
  const exec: ExecuteContext = { ...ctx, timeoutMs: 30_000, reasoning: null };
  const runId = await createRun(exec, doc);
  const task = await seedTask(ctx, doc, runId, 80);
  const cfg = makeRunConfig({ ...exec, model: 'invalid/does-not-exist' });
  cfg.callModel = makeCallModel({ functionsUrl: ctx.functionsUrl, anonKey: ctx.anonKey, accessToken: ctx.accessToken });
  await runTask(ctx.db, (await ctx.db.get('tasks', task.id))!, cfg);
  const final = (await ctx.db.get('tasks', task.id))!;
  const pass = final.status === 'failed' && final.attemptNo === 1 && !!final.failureCode;
  return { pass, detail: `status=${final.status}, failure=${final.failureCode}, attempts=${final.attemptNo}`, task: final };
}
