import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { openHarnessDb, type HarnessDBHandle } from './db';
import { makeCallModel } from './callModel';
import { runTask } from './runTask';
import { validateClauseItem } from '../tasks/schema';
import { ACTIVE_STATUSES, type ResultRow, type RunConfig, type Task } from '../tasks/types';

export interface StartMessage {
  type: 'start';
  runId: string;
  docHash: string;
  supabaseUrl: string;
  anonKey: string;
  accessToken: string;
  model: string;
  fallbackModel: string | null;
  timeoutMs: number;
}

const CONCURRENCY = 2;
const POLL_MS = 2000;
const UNREACHABLE_PAUSE_MS = 10000;

const ctx = self as unknown as { postMessage: (m: unknown) => void; onmessage: ((e: MessageEvent) => void) | null };
const post = (m: unknown) => ctx.postMessage(m);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

ctx.onmessage = (e: MessageEvent<StartMessage>) => {
  if (e.data.type === 'start') void start(e.data);
};

async function start(msg: StartMessage) {
  await navigator.locks.request(`doc:${msg.docHash}`, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      post({ type: 'locked', docHash: msg.docHash });
      return;
    }
    try {
      await drive(msg);
    } catch (e) {
      post({ type: 'error', message: String(e) });
    }
  });
}

async function readRunStatus(sb: SupabaseClient, runId: string): Promise<string | null> {
  const { data, error } = await sb.from('runs').select('status').eq('id', runId).maybeSingle();
  if (error || !data) return null;
  return data.status as string;
}

async function drive(msg: StartMessage) {
  const db: HarnessDBHandle = await openHarnessDb();
  const sb = createClient(msg.supabaseUrl, msg.anonKey, {
    global: { headers: { Authorization: `Bearer ${msg.accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const cfg: RunConfig = {
    callModel: makeCallModel({ functionsUrl: `${msg.supabaseUrl}/functions/v1`, anonKey: msg.anonKey, accessToken: msg.accessToken }),
    saveResult: async (row: ResultRow) => {
      const { error } = await sb.rpc('save_task_result', { p_row: row });
      if (error) throw error;
    },
    validateItem: validateClauseItem,
    model: msg.model,
    fallbackModel: msg.fallbackModel,
    timeoutMs: msg.timeoutMs,
    maxRetries: 3,
    minPieceChars: 800,
    maxSplitDepth: 4,
    backoffMs: (n) => Math.min(30000, 2000 * 2 ** (n - 1)),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };

  // Tasks left in "requesting" had a request in flight when the tab died. Their outcome is unknown.
  const existing = await db.getAllFromIndex('tasks', 'byRun', msg.runId);
  for (const t of existing) {
    if (t.status === 'requesting') await db.put('tasks', { ...t, status: 'uncertain', updatedAt: Date.now() });
  }

  const running = new Map<string, Promise<void>>();

  const runOne = async (t: Task) => {
    const fresh = await db.get('tasks', t.id);
    if (!fresh || !ACTIVE_STATUSES.includes(fresh.status)) return;
    try {
      const outcome = await runTask(db, fresh, cfg);
      post({ type: 'step', taskId: t.id, outcome });
    } catch (e) {
      post({ type: 'error', taskId: t.id, message: String(e) });
      await db.put('tasks', { ...fresh, status: 'failed', failureCode: 'internal', failureMessage: String(e), nextAt: 0, updatedAt: Date.now() });
    }
  };

  for (;;) {
    const status = await readRunStatus(sb, msg.runId);
    if (status === null) {
      post({ type: 'paused', reason: 'supabase_unreachable' });
      await sleep(UNREACHABLE_PAUSE_MS);
      continue;
    }
    if (status !== 'running') {
      const tasks = await db.getAllFromIndex('tasks', 'byRun', msg.runId);
      for (const t of tasks) {
        if (ACTIVE_STATUSES.includes(t.status)) await db.put('tasks', { ...t, status: 'cancelled', updatedAt: Date.now() });
      }
      post({ type: 'stopped', status });
      return;
    }

    const tasks = await db.getAllFromIndex('tasks', 'byRun', msg.runId);
    const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
    if (active.length === 0 && running.size === 0) {
      await sb.from('runs').update({ status: 'complete', updated_at: new Date().toISOString() }).eq('id', msg.runId).eq('status', 'running');
      post({ type: 'complete' });
      return;
    }

    const now = Date.now();
    for (const t of active) {
      if (running.size >= CONCURRENCY) break;
      if (running.has(t.id) || t.nextAt > now) continue;
      running.set(
        t.id,
        runOne(t).finally(() => running.delete(t.id)),
      );
    }

    if (running.size > 0) {
      await Promise.race([...running.values(), sleep(POLL_MS)]);
    } else {
      const wait = Math.min(...active.map((t) => t.nextAt)) - now;
      await sleep(Math.min(POLL_MS, Math.max(100, wait)));
    }
  }
}
