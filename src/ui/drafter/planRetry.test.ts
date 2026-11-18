import { describe, expect, it } from 'vitest';
import { buildDocAliases } from '../../drafter/plan';
import { runPlanCall, type PlanStream } from '../../drafter/planCall';
import type { DraftRecord } from '../../drafter/types';
import { PLAN_ATTEMPTS, attemptPreview, runPlanAttempts, shouldRetryPlanCall } from './planRetry';

type FakeResult = { ok: boolean; code?: string; raw?: string };

describe('plan retry decision', () => {
  it('retries a non-JSON reply and an empty reply once', () => {
    expect(shouldRetryPlanCall('bad_json')).toBe(true);
    expect(shouldRetryPlanCall('empty_output')).toBe(true);
    expect(PLAN_ATTEMPTS).toBe(2);
  });

  it('never retries a cut-off reply, an auth or proxy error, a network failure or an abort', () => {
    for (const code of [
      'length',
      'not_object',
      'http_400',
      'http_401',
      'http_403',
      'http_429',
      'http_500',
      'network',
      'stream_interrupted',
      'aborted',
      '',
      undefined,
    ]) {
      expect(shouldRetryPlanCall(code)).toBe(false);
    }
  });
});

describe('plan attempts', () => {
  it('stops on the first good reply', async () => {
    let calls = 0;
    const { result, attempts } = await runPlanAttempts(
      async () => {
        calls += 1;
        return { ok: true } satisfies FakeResult;
      },
      (r) => !r.ok,
    );
    expect(result.ok).toBe(true);
    expect(attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it('tries once more after a retryable failure and returns the good reply', async () => {
    const replies: FakeResult[] = [{ ok: false, code: 'bad_json', raw: 'not json' }, { ok: true }];
    let calls = 0;
    const { result, attempts } = await runPlanAttempts(
      async () => replies[Math.min(calls++, replies.length - 1)],
      (r) => !r.ok,
    );
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('surfaces a second failure once and does not try a third time', async () => {
    let calls = 0;
    const { result, attempts } = await runPlanAttempts(
      async () => {
        calls += 1;
        return { ok: false, code: 'bad_json', raw: `attempt ${calls}` } satisfies FakeResult;
      },
      (r) => !r.ok,
    );
    expect(result).toEqual({ ok: false, code: 'bad_json', raw: 'attempt 2' });
    expect(attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('does not retry a result the decision rejects', async () => {
    let calls = 0;
    const { result, attempts } = await runPlanAttempts(
      async () => {
        calls += 1;
        return { ok: false, code: 'length' } satisfies FakeResult;
      },
      (r) => shouldRetryPlanCall(r.code),
    );
    expect(result).toEqual({ ok: false, code: 'length' });
    expect(attempts).toBe(1);
    expect(calls).toBe(1);
  });
});

describe('raw reply preview', () => {
  it('collapses whitespace and keeps the first 300 characters', () => {
    expect(attemptPreview('  Here\n\n  is\tJSON  ')).toBe('Here is JSON');
    expect(attemptPreview('x'.repeat(1000))).toHaveLength(300);
  });

  it('is empty for no reply', () => {
    expect(attemptPreview('')).toBe('');
    expect(attemptPreview(null)).toBe('');
    expect(attemptPreview(undefined)).toBe('');
    expect(attemptPreview('   \n ')).toBe('');
  });
});

// Through the real call wrapper: the retry repeats the identical request, and a reply that is
// still bad after the retry reports the failure once.
const docs = buildDocAliases([{ refDocId: 'doc-a', name: 'Lease.pdf', pageCount: 10, available: true }]);

function draft(): DraftRecord {
  return {
    id: 'draft-1',
    userId: 'user-a',
    title: 'Lease',
    instruction: 'Draft a lease.',
    referenceDocIds: [],
    reviewingFor: 'neutral',
    status: 'brief',
    particulars: null,
    sourcePlan: null,
    outline: null,
    sourceText: null,
    clauses: {},
    writeRun: null,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('plan call with one retry', () => {
  it('sends the same request twice and reports the final failure once', async () => {
    const seen: { model: string; maxTokens: number; messages: unknown }[] = [];
    const stream: PlanStream = async (opts) => {
      seen.push({ model: opts.model, maxTokens: opts.maxTokens, messages: opts.messages });
      opts.onDelta('Here is your JSON: {');
      return { text: 'Here is your JSON: {', finishReason: 'stop' };
    };
    let calls = 0;
    const { result, attempts } = await runPlanAttempts(
      () => {
        calls += 1;
        return runPlanCall(
          { functionsUrl: 'http://proxy.test/functions/v1', anonKey: 'anon', getToken: async () => 'token', model: 'plan-model', maxTokens: 1600, stream },
          draft(),
          docs,
        );
      },
      (outcome) => !outcome.ok && shouldRetryPlanCall(outcome.code),
    );

    expect(calls).toBe(2);
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ ok: false, code: 'bad_json' });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
  });

  it('does not repeat a reply cut at the output limit', async () => {
    const stream: PlanStream = async (opts) => {
      opts.onDelta('{"docType":');
      return { text: '{"docType":', finishReason: 'length' };
    };
    let calls = 0;
    const { result, attempts } = await runPlanAttempts(
      () => {
        calls += 1;
        return runPlanCall(
          { functionsUrl: 'http://proxy.test/functions/v1', anonKey: 'anon', getToken: async () => 'token', model: 'plan-model', stream },
          draft(),
          docs,
        );
      },
      (outcome) => !outcome.ok && shouldRetryPlanCall(outcome.code),
    );
    expect(result).toMatchObject({ ok: false, code: 'length' });
    expect(calls).toBe(1);
    expect(attempts).toBe(1);
  });
});
