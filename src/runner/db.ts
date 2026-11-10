import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RawResponse, Task } from '../tasks/types';

export type DocStatus = 'new' | 'processing' | 'review' | 'ready';

export type PageStatus = 'native' | 'ocr' | 'review' | 'accepted' | 'blank';

export const FINAL_PAGE_STATUSES: PageStatus[] = ['native', 'ocr', 'accepted', 'blank'];

export interface DocumentRecord {
  id: string;
  name: string;
  hash: string;
  size: number;
  pdf?: Blob;
  createdAt: number;
  status: DocStatus;
  ocrLangs: string;
  pageCount: number;
  prepFingerprint: string | null;
  chunkCount: number;
}

export interface PageRecord {
  docId: string;
  pageNo: number;
  text: string;
  status: PageStatus;
  source: 'native' | 'ocr' | 'manual' | null;
  reason: string | null;
  dpi: number | null;
  nativeChars: number;
  imageCount: number;
  updatedAt: number;
}

export interface OcrDecision {
  docId: string;
  pageNo: number;
  decision: 'accept' | 'correct' | 'blank' | 'unresolved';
  text: string;
  savedAt: number;
}

export interface ChunkRecord {
  id: string;
  docId: string;
  index: number;
  text: string;
  carried: string | null;
  pageStart: number;
  pageEnd: number;
  clauseFrom: string | null;
  clauseTo: string | null;
  heading: string | null;
  parentSection: string | null;
  tokenEst: number;
  units: number;
  oversize: boolean;
}

export interface HarnessDB extends DBSchema {
  documents: { key: string; value: DocumentRecord };
  pages: { key: [string, number]; value: PageRecord };
  chunks: { key: string; value: ChunkRecord };
  embeddings: { key: string; value: { chunkId: string; model: string; vector: Float32Array } };
  tasks: { key: string; value: Task; indexes: { byRun: string } };
  raw_responses: { key: string; value: RawResponse };
  ocr_decisions: { key: [string, number]; value: OcrDecision };
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
