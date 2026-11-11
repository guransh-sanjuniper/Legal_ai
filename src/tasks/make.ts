import { taskFingerprint } from './fingerprint';
import type { Task, TaskSpec } from './types';

export async function makeTask(spec: TaskSpec, now: number): Promise<Task> {
  return {
    ...spec,
    fingerprint: await taskFingerprint(spec),
    status: 'queued',
    attemptNo: 0,
    attemptId: null,
    model: null,
    nextAt: 0,
    failureCode: null,
    failureMessage: null,
    finishReason: null,
    provider: null,
    promptTokens: null,
    completionTokens: null,
    durationMs: null,
    rejectedItems: 0,
    updatedAt: now,
  };
}
