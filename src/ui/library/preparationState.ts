import { FINAL_PAGE_STATUSES, type DocumentRecord, type HarnessDBHandle } from '../../runner/db';
import { EMBED_MODEL_VERSION } from '../../retrieval/config';
import { DEFINITIONS_PROMPT_VERSION } from '../../retrieval/definitions';
import { sha256Hex } from '../../tasks/fingerprint';

// Preparation stages are the order the library runs them. Ingestion already includes
// chunking; the index is a warm-up of the retrieval worker's MiniSearch index, not a
// persisted store, so it is recorded here rather than in IndexedDB.
export type PreparationStage =
  | 'ingest'
  | 'embeddings'
  | 'index'
  | 'definitions'
  | 'ready'
  | 'needs-review'
  | 'failed';

export interface PreparationFailure {
  stage: PreparationStage;
  message: string;
}

export interface PreparationState {
  docId: string;
  stage: PreparationStage;
  completedStages: PreparationStage[];
  // The document's preparation fingerprint at the time the run started. A changed
  // fingerprint (OCR corrections, page changes) invalidates the completed stages.
  docPrepFingerprint: string | null;
  progress: { done: number; total: number } | null;
  message: string | null;
  review: { pages: number } | null;
  failed: PreparationFailure | null;
  preparedAt: number | null;
  preparedFingerprint: string | null;
  updatedAt: number;
}

const STORAGE_PREFIX = 'legal-app.prep.';

export function preparationStateKey(docId: string): string {
  return `${STORAGE_PREFIX}${docId}`;
}

export function readPreparationState(docId: string): PreparationState | null {
  try {
    const raw = localStorage.getItem(preparationStateKey(docId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PreparationState;
    if (!parsed || typeof parsed !== 'object' || parsed.docId !== docId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePreparationState(state: PreparationState): void {
  try {
    localStorage.setItem(preparationStateKey(state.docId), JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode); the in-memory state still works.
  }
}

export function clearPreparationState(docId: string): void {
  try {
    localStorage.removeItem(preparationStateKey(docId));
  } catch {
    // ignore
  }
}

// The stored fingerprint includes the embedding model version, so a model change
// invalidates "Ready" without changing the document's own preparation fingerprint.
export async function computePreparedFingerprint(doc: DocumentRecord): Promise<string> {
  return sha256Hex(JSON.stringify([doc.prepFingerprint, EMBED_MODEL_VERSION, DEFINITIONS_PROMPT_VERSION]));
}

export interface DurablePreparation {
  hasChunks: boolean;
  embeddingsReady: boolean;
  embeddingsAt: number | null;
  definitionsReady: boolean;
  definitionsAt: number | null;
  prepared: boolean;
}

// Durable records are the source of truth for "already prepared". A document prepared
// in the harness (no wrapper state) can reach Ready without running any stage again.
export async function durablePreparation(db: HarnessDBHandle, doc: DocumentRecord): Promise<DurablePreparation> {
  const hasChunks = doc.status === 'ready' && Boolean(doc.prepFingerprint) && doc.chunkCount > 0;

  const embedding = await db.get('embedding_state', doc.id);
  const embeddingsReady =
    hasChunks &&
    Boolean(embedding?.completedAt) &&
    embedding?.prepFingerprint === doc.prepFingerprint &&
    embedding?.modelVersion === EMBED_MODEL_VERSION;

  const definitions = await db.get('definitions', doc.id);
  const definitionsFailed =
    hasChunks && Boolean(definitions) && (await hasFailedDefinitionTasks(db, doc));
  const definitionsReady =
    hasChunks &&
    Boolean(definitions) &&
    definitions?.prepFingerprint === doc.prepFingerprint &&
    !definitionsFailed;

  return {
    hasChunks,
    embeddingsReady,
    embeddingsAt: embedding?.completedAt ?? null,
    definitionsReady,
    definitionsAt: definitions?.updatedAt ?? null,
    prepared: hasChunks && embeddingsReady && definitionsReady,
  };
}

// The definitions task records a failed count but the sheet record does not. A failed
// task for this document fingerprint means the sheet is partial and must be retried.
async function hasFailedDefinitionTasks(db: HarnessDBHandle, doc: DocumentRecord): Promise<boolean> {
  const tasks = await db.getAll('tasks');
  return tasks.some(
    (task) =>
      task.docHash === doc.hash &&
      task.prepFingerprint === doc.prepFingerprint &&
      task.promptVersion === DEFINITIONS_PROMPT_VERSION &&
      task.status === 'failed',
  );
}

export async function isPrepared(db: HarnessDBHandle, doc: DocumentRecord): Promise<boolean> {
  const durable = await durablePreparation(db, doc);
  return durable.prepared;
}

export async function countReviewPages(db: HarnessDBHandle, docId: string): Promise<number> {
  let count = 0;
  let cursor = await db
    .transaction('pages')
    .store.openCursor(IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]));
  while (cursor) {
    if (!FINAL_PAGE_STATUSES.includes(cursor.value.status)) count++;
    cursor = await cursor.continue();
  }
  return count;
}
