import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle } from './db';
import { makeTask } from '../tasks/make';
import { sha256Hex } from '../tasks/fingerprint';
import { CLAUSE_PROMPT, PROMPT_VERSION } from '../tasks/schema';
import type { StartMessage } from './worker';

export const PREP_FINGERPRINT = 'handmade-v1';

export async function createHandmadeRun(
  db: HarnessDBHandle,
  sb: SupabaseClient,
  opts: { input: string; maxTokens: number; userId: string },
): Promise<{ runId: string; docHash: string; taskId: string }> {
  const docHash = await sha256Hex(opts.input);
  const runId = crypto.randomUUID();

  const { error } = await sb.from('runs').insert({
    id: runId,
    user_id: opts.userId,
    doc_hash: docHash,
    prep_fingerprint: PREP_FINGERPRINT,
    status: 'running',
  });
  if (error) throw error;

  const now = Date.now();
  const task = await makeTask(
    {
      id: `${runId}:t0`,
      runId,
      parentId: null,
      depth: 0,
      docHash,
      prepFingerprint: PREP_FINGERPRINT,
      promptVersion: PROMPT_VERSION,
      prompt: CLAUSE_PROMPT,
      input: opts.input,
      maxTokens: opts.maxTokens,
    },
    now,
  );
  await db.put('tasks', task);
  await db.put('run_state', { runId, docHash, status: 'running', updatedAt: now });
  return { runId, docHash, taskId: task.id };
}

export function startRunWorker(
  msg: Omit<StartMessage, 'type'>,
  onEvent: (event: unknown) => void,
): Worker {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => onEvent(e.data);
  worker.postMessage({ type: 'start', ...msg } satisfies StartMessage);
  return worker;
}
