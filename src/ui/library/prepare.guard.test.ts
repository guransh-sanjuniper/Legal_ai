import { describe, expect, it, vi } from 'vitest';
import type { DocumentRecord, HarnessDBHandle } from '../../runner/db';
import { getActiveDocId, runPreparation } from './prepare';

// The queue relies on this: a needs-review pause must release the tab's global
// "one preparation" guard in prepare.ts, otherwise the next queued file could never
// start. The regression test is outside the harness modules and changes nothing in them.

const testState = vi.hoisted(() => ({
  docs: new Map<string, unknown>(),
  reviewPages: 2,
}));

vi.mock('../../runner/db', () => ({
  openHarnessDb: async () => {
    throw new Error('openHarnessDb should not be used in this test.');
  },
}));

vi.mock('../../retrieval/client', () => ({
  RetrievalClient: class {
    dispose(): void {}
    async embed(): Promise<void> {}
    async search(): Promise<unknown[]> {
      return [];
    }
  },
}));

vi.mock('../../retrieval/definitions', () => ({
  buildDefinitionsSheet: async () => ({ failed: 0 }),
}));

vi.mock('../../lib/supabase', () => ({
  supabase: null,
  supabaseAnonKey: '',
  supabaseUrl: 'https://example.test',
}));

vi.mock('./ingestRunner', () => ({
  startIngestWorker: (docId: string, onEvent: (event: { type: string }) => void) => {
    const doc = testState.docs.get(docId) as { status: string } | undefined;
    if (doc) doc.status = 'review';
    setTimeout(() => onEvent({ type: 'idle' }), 0);
    return { terminate: () => {} };
  },
}));

vi.mock('./preparationState', () => ({
  computePreparedFingerprint: async () => 'prepared-fingerprint',
  countReviewPages: async () => testState.reviewPages,
  durablePreparation: async () => ({
    hasChunks: false,
    embeddingsReady: false,
    embeddingsAt: null,
    definitionsReady: false,
    definitionsAt: null,
    prepared: false,
  }),
  readPreparationState: () => null,
  writePreparationState: () => {},
}));

function makeDocument(id: string, hash: string): DocumentRecord {
  return {
    id,
    name: `${id}.pdf`,
    hash,
    size: 1,
    createdAt: 1,
    status: 'new',
    ocrLangs: 'eng',
    pageCount: 0,
    prepFingerprint: null,
    chunkCount: 0,
  };
}

function makeDb(): HarnessDBHandle {
  return {
    get: async (store: string, key: string) =>
      store === 'documents' ? (testState.docs.get(key) as DocumentRecord | undefined) : undefined,
  } as unknown as HarnessDBHandle;
}

describe('preparation guard', () => {
  it('releases the one-preparation guard when a document pauses for review', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          callback: (lock: { name: string }) => Promise<void>,
        ) => callback({ name: 'doc-lock' }),
      },
    });

    const db = makeDb();
    testState.docs.set('doc1', makeDocument('doc1', 'hash1'));
    testState.docs.set('doc2', makeDocument('doc2', 'hash2'));

    const first = await runPreparation('doc1', { db });
    expect(first.stage).toBe('needs-review');
    expect(first.review?.pages).toBe(2);
    expect(getActiveDocId()).toBeNull();

    // The next queued file can start immediately; the first document is only waiting
    // for a person, not holding the tab's preparation slot.
    const second = await runPreparation('doc2', { db });
    expect(second.stage).toBe('needs-review');
    expect(getActiveDocId()).toBeNull();
  });
});
