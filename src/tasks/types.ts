export type TaskStatus =
  | 'queued'
  | 'requesting'
  | 'received'
  | 'retry_wait'
  | 'uncertain'
  | 'split'
  | 'done'
  | 'failed'
  | 'cancelled';

export const ACTIVE_STATUSES: TaskStatus[] = ['queued', 'requesting', 'received', 'retry_wait', 'uncertain'];

export class CallError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

export interface TaskSpec {
  id: string;
  runId: string;
  parentId: string | null;
  depth: number;
  docHash: string;
  prepFingerprint: string;
  promptVersion: string;
  prompt: string;
  input: string;
  maxTokens: number;
}

export interface Task extends TaskSpec {
  fingerprint: string;
  status: TaskStatus;
  attemptNo: number;
  attemptId: string | null;
  model: string | null;
  nextAt: number;
  failureCode: string | null;
  finishReason: string | null;
  provider: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  rejectedItems: number;
  updatedAt: number;
}

export interface RawResponse {
  key: string;
  taskId: string;
  attemptId: string;
  text: string;
  finishReason: string;
  provider: string | null;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
  savedAt: number;
}

export interface CallRequest {
  model: string;
  prompt: string;
  input: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface CallResult {
  text: string;
  finishReason: string;
  provider: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
}

export interface ResultRow {
  run_id: string;
  task_id: string;
  fingerprint: string;
  attempt_id: string | null;
  attempt_no: number;
  model: string | null;
  provider: string | null;
  finish_reason: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  failure_code: string | null;
  rejected_items: number;
  payload: unknown | null;
}

export type StepOutcome = 'done' | 'split' | 'retry_wait' | 'failed' | 'stale' | 'save_pending';

export interface RunConfig {
  callModel: (req: CallRequest) => Promise<CallResult>;
  saveResult: (row: ResultRow) => Promise<void>;
  validateItem: (item: unknown) => boolean;
  model: string;
  fallbackModel: string | null;
  timeoutMs: number;
  maxRetries: number;
  minPieceChars: number;
  maxSplitDepth: number;
  backoffMs: (attemptNo: number) => number;
  now: () => number;
  newId: () => string;
}
