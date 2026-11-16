import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { openHarnessDb } from '../runner/db';

// The Drafter has its own database. This locks the harness schema so a later change cannot
// quietly bump the version or add a store to the pipeline database.
const HARNESS_DB_NAME = 'pipeline-harness';
const HARNESS_DB_VERSION = 3;
const HARNESS_STORES = [
  'documents',
  'pages',
  'chunks',
  'embeddings',
  'embedding_windows',
  'embedding_state',
  'definitions',
  'analysis_reports',
  'analysis_state',
  'tasks',
  'raw_responses',
  'ocr_decisions',
  'run_state',
];

describe('pipeline-harness schema', () => {
  it('keeps its name, version and store list', async () => {
    const db = await openHarnessDb();
    try {
      expect(db.name).toBe(HARNESS_DB_NAME);
      expect(db.version).toBe(HARNESS_DB_VERSION);
      expect(Array.from(db.objectStoreNames).sort()).toEqual([...HARNESS_STORES].sort());
    } finally {
      db.close();
      await deleteDB(HARNESS_DB_NAME);
    }
  });
});
