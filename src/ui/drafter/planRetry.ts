// One automatic retry for the Drafter plan call, and nothing more.
//
// The instruction parse asks a small non-reasoning model for one JSON object. A reply that is
// not JSON, or is empty, is almost always a one-off formatting slip: the identical request
// normally succeeds on the next call. Only those two outcomes are retried, exactly once, with
// the same input. A reply cut at the output limit, a proxy or auth error, a network failure, an
// interrupted stream or an aborted call stop immediately and surface as they do today.

export const PLAN_ATTEMPTS = 2;

export const PLAN_RETRY_CODES = ['bad_json', 'empty_output'] as const;

export function shouldRetryPlanCall(code: string | null | undefined): boolean {
  return code === 'bad_json' || code === 'empty_output';
}

export interface PlanAttemptsResult<R> {
  result: R;
  attempts: number;
}

// Calls `call` again only while the result is retryable and the attempt cap allows it. The
// caller owns the input: every attempt is made by the same closure, so nothing that is sent
// can change between attempts.
export async function runPlanAttempts<R>(
  call: () => Promise<R>,
  retryable: (result: R) => boolean,
  maxAttempts: number = PLAN_ATTEMPTS,
): Promise<PlanAttemptsResult<R>> {
  const limit = Math.max(1, Math.floor(maxAttempts));
  let result = await call();
  let attempts = 1;
  while (attempts < limit && retryable(result)) {
    result = await call();
    attempts += 1;
  }
  return { result, attempts };
}

// The first characters of a raw reply, with runs of whitespace collapsed, for a developer-mode
// diagnostic line. Same rule as the failed-task table.
export function attemptPreview(raw: string | null | undefined, limit = 300): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.slice(0, Math.max(0, limit));
}
