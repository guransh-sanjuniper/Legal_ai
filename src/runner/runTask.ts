import type { HarnessDBHandle } from './db';
import { rawKey } from './db';
import { parseItems } from '../tasks/parse';
import { makeTask } from '../tasks/make';
import { splitInput } from '../tasks/split';
import {
  CallError,
  type CallResult,
  type RawResponse,
  type ResultRow,
  type RunConfig,
  type StepOutcome,
  type Task,
  type TaskSpec,
} from '../tasks/types';

const SAVE_RETRY_MS = 5000;

function isRetryable(code: string): boolean {
  return ['timeout', 'network', 'stream_interrupted', 'bad_json', 'validation', 'http_429'].includes(code) || /^http_5\d\d$/.test(code);
}

export async function runTask(db: HarnessDBHandle, task: Task, cfg: RunConfig): Promise<StepOutcome> {
  if (task.status === 'received' && task.attemptId) {
    const raw = await db.get('raw_responses', rawKey(task.id, task.attemptId));
    if (raw) return finishFromRaw(db, task, raw, cfg);
  }
  return attempt(db, task, cfg);
}

async function attempt(db: HarnessDBHandle, task: Task, cfg: RunConfig): Promise<StepOutcome> {
  const attemptNo = task.attemptNo + 1;
  const model = cfg.fallbackModel && attemptNo === cfg.maxRetries + 1 ? cfg.fallbackModel : cfg.model;
  const attemptId = cfg.newId();
  const started = cfg.now();

  const requesting: Task = {
    ...task,
    status: 'requesting',
    attemptNo,
    attemptId,
    model,
    nextAt: 0,
    failureCode: null,
    failureMessage: null,
    finishReason: null,
    provider: null,
    updatedAt: started,
  };
  await db.put('tasks', requesting);

  let res: CallResult;
  try {
    res = await cfg.callModel({
      model,
      prompt: task.prompt,
      input: task.input,
      maxTokens: task.maxTokens,
      timeoutMs: cfg.timeoutMs,
      reasoning: cfg.reasoning ?? null,
    });
  } catch (e) {
    const code = e instanceof CallError ? e.code : 'network';
    const message = e instanceof CallError ? e.message : String(e);
    return fail(db, requesting, code, cfg, cfg.now() - started, message);
  }

  const raw: RawResponse = {
    key: rawKey(task.id, attemptId),
    taskId: task.id,
    attemptId,
    text: res.text,
    finishReason: res.finishReason,
    provider: res.provider,
    model,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
    durationMs: res.durationMs,
    savedAt: cfg.now(),
  };
  const received: Task = {
    ...requesting,
    status: 'received',
    finishReason: res.finishReason,
    provider: res.provider,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
    durationMs: res.durationMs,
    updatedAt: cfg.now(),
  };

  const tx = db.transaction(['tasks', 'raw_responses'], 'readwrite');
  const current = await tx.objectStore('tasks').get(task.id);
  if (!current || current.attemptId !== attemptId) {
    await tx.done;
    return 'stale';
  }
  await tx.objectStore('raw_responses').put(raw);
  await tx.objectStore('tasks').put(received);
  await tx.done;

  return finishFromRaw(db, received, raw, cfg);
}

async function finishFromRaw(db: HarnessDBHandle, task: Task, raw: RawResponse, cfg: RunConfig): Promise<StepOutcome> {
  const now = cfg.now();

  if (raw.finishReason === 'length') {
    // Some reasoning models spend the whole budget on reasoning and emit no text. Splitting
    // the input cannot help there, so fail instead of fanning out more paid calls.
    if (raw.text.trim().length === 0) return fail(db, task, 'empty_output', cfg);
    const pieces = splitInput(task.input, cfg.minPieceChars);
    if (!pieces || task.depth + 1 > cfg.maxSplitDepth) return fail(db, task, 'length', cfg);
    const specs: TaskSpec[] = pieces.map((input, i) => ({
      id: `${task.id}/${'ab'[i]}`,
      runId: task.runId,
      parentId: task.id,
      depth: task.depth + 1,
      docHash: task.docHash,
      prepFingerprint: task.prepFingerprint,
      promptVersion: task.promptVersion,
      prompt: task.prompt,
      input,
      maxTokens: task.maxTokens,
    }));
    const children = await Promise.all(specs.map((s) => makeTask(s, now)));
    const tx = db.transaction('tasks', 'readwrite');
    for (const child of children) {
      if (!(await tx.store.get(child.id))) await tx.store.add(child);
    }
    await tx.store.put({ ...task, status: 'split', updatedAt: now });
    await tx.done;
    return 'split';
  }

  if (raw.finishReason !== 'stop') return fail(db, task, 'finish_reason', cfg);

  const parsed = parseItems(raw.text, cfg.validateItem);
  if ('error' in parsed) return fail(db, task, parsed.error, cfg);

  const row: ResultRow = toRow(task, { items: parsed.items }, null, parsed.rejected);
  try {
    await cfg.saveResult(row);
  } catch {
    await db.put('tasks', { ...task, rejectedItems: parsed.rejected, nextAt: now + SAVE_RETRY_MS, updatedAt: now });
    return 'save_pending';
  }

  await db.put('tasks', { ...task, status: 'done', rejectedItems: parsed.rejected, nextAt: 0, failureCode: null, failureMessage: null, updatedAt: now });
  return 'done';
}

async function fail(
  db: HarnessDBHandle,
  task: Task,
  code: string,
  cfg: RunConfig,
  durationMs?: number,
  message?: string | null,
): Promise<StepOutcome> {
  const now = cfg.now();
  const canRetry = isRetryable(code) && task.attemptNo < cfg.maxRetries + 1;
  const next: Task = {
    ...task,
    status: canRetry ? 'retry_wait' : 'failed',
    failureCode: code,
    failureMessage: message ?? null,
    nextAt: canRetry ? now + cfg.backoffMs(task.attemptNo) : 0,
    durationMs: durationMs ?? task.durationMs,
    updatedAt: now,
  };
  await db.put('tasks', next);

  if (!canRetry) {
    try {
      await cfg.saveResult(toRow(next, null, code, next.rejectedItems));
    } catch {
      // The failure stays in IndexedDB; the Supabase failure row is best effort.
    }
    return 'failed';
  }
  return 'retry_wait';
}

function toRow(task: Task, payload: unknown | null, failureCode: string | null, rejected: number): ResultRow {
  return {
    run_id: task.runId,
    task_id: task.id,
    fingerprint: task.fingerprint,
    attempt_id: task.attemptId,
    attempt_no: task.attemptNo,
    model: task.model,
    provider: task.provider,
    finish_reason: task.finishReason,
    prompt_tokens: task.promptTokens,
    completion_tokens: task.completionTokens,
    duration_ms: task.durationMs,
    failure_code: failureCode,
    failure_message: task.failureMessage,
    rejected_items: rejected,
    payload,
  };
}
