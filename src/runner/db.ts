import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RawResponse, Task } from '../tasks/types';

export interface HarnessDB extends DBSchema {
  documents: { key: string; value: { id: string; name: string; hash: string; pdf?: Blob; createdAt: number } };
  pages: { key: [string, number]; value: { docId: string; pageNo: number; text: string; status: string } };
  chunks: {
    key: string;
    value: { id: string; docId: string; pageStart: number; pageEnd: number; clauseNo: string | null; heading: string | null; text: string };
  };
  embeddings: { key: string; value: { chunkId: string; model: string; vector: Float32Array } };
  tasks: { key: string; value: Task; indexes: { byRun: string } };
  raw_responses: { key: string; value: RawResponse };
  ocr_decisions: { key: [string, number]; value: { docId: string; pageNo: number; decision: string; correction: string | null; savedAt: number } };
  run_state: { key: string; value: { runId: string; docHash: string; status: string; updatedAt: number } };
}

export type HarnessDBHandle = IDBPDatabase<HarnessDB>;

export function openHarnessDb(): Promise<HarnessDBHandle> {
  return openDB<HarnessDB>('pipeline-harness', 1, {
    upgrade(db) {
      db.createObjectStore('documents', { keyPath: 'id' });
      db.createObjectStore('pages');
      db.createObjectStore('chunks', { keyPath: 'id' });
      db.createObjectStore('embeddings', { keyPath: 'chunkId' });
      const tasks = db.createObjectStore('tasks', { keyPath: 'id' });
      tasks.createIndex('byRun', 'runId');
      db.createObjectStore('raw_responses', { keyPath: 'key' });
      db.createObjectStore('ocr_decisions');
      db.createObjectStore('run_state', { keyPath: 'runId' });
    },
  });
}

export function rawKey(taskId: string, attemptId: string): string {
  return `${taskId}|${attemptId}`;
}
