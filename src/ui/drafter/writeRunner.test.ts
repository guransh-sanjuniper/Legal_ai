import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftRecord } from '../../drafter/types';
import type { DrafterDBHandle } from '../../drafter/store';
import type { WriteEngineOptions } from '../../drafter/write';

const mocks = vi.hoisted(() => ({
  runWriting: vi.fn(),
  runWithDraftLock: vi.fn(),
  writeSection: vi.fn(),
}));

vi.mock('../../drafter/write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../drafter/write')>();
  return {
    ...actual,
    runWriting: mocks.runWriting,
    runWithDraftLock: mocks.runWithDraftLock,
  };
});

vi.mock('../../drafter/writeCall', () => ({ writeSection: mocks.writeSection }));
vi.mock('../analysis/runtime', () => ({
  functionsEndpoint: () => ({ functionsUrl: 'http://test', anonKey: 'key' }),
  freshToken: async () => 'token',
}));
vi.mock('../../lib/supabase', () => ({ supabase: {} }));
vi.mock('../../drafter/sync', () => ({ syncDraftById: vi.fn() }));

import { isWriting, startWriting, subscribeWriting } from './writeRunner';

const draft = {
  id: 'draft-runner-test',
  clauses: {},
  writeRun: null,
} as unknown as DraftRecord;

const db = {} as DrafterDBHandle;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runWithDraftLock.mockImplementation(
    async (_id: string, run: () => Promise<unknown>) => ({ ran: true, value: await run() }),
  );
  mocks.runWriting.mockImplementation(async (opts: WriteEngineOptions) => {
    const run = {
      startedAt: '2026-11-17T00:00:00.000Z',
      finishedAt: '2026-11-17T00:00:01.000Z',
      calls: 1,
      retries: 0,
      rateLimitEvents: 0,
      rateLimitWaitMs: 0,
    };
    opts.onUpdate?.({ clauses: opts.draft.clauses, run });
    return { clauses: opts.draft.clauses, run, stopped: false };
  });
});

describe('write runner lifecycle', () => {
  it('cleans the runner after a run even when a listener throws', async () => {
    const lives: { active: boolean }[] = [];
    const unsubscribe = subscribeWriting(draft.id, (live) => {
      lives.push({ active: live.active });
      if (lives.length === 1) throw new Error('listener failure');
    });

    await startWriting(db, draft, { onlyItemIds: ['i1'] });

    expect(isWriting(draft.id)).toBe(false);
    expect(lives.some((live) => !live.active)).toBe(true);

    unsubscribe();
  });

  it('starts a real run again after the previous run ended', async () => {
    const unsubscribe = subscribeWriting(draft.id, () => undefined);

    await startWriting(db, draft);
    expect(isWriting(draft.id)).toBe(false);

    await startWriting(db, draft);
    expect(mocks.runWriting).toHaveBeenCalledTimes(2);
    expect(isWriting(draft.id)).toBe(false);

    unsubscribe();
  });
});
