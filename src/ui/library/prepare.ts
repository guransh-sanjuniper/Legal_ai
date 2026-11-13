import { openHarnessDb, type DocumentRecord, type HarnessDBHandle } from '../../runner/db';
import { RetrievalClient } from '../../retrieval/client';
import { buildDefinitionsSheet } from '../../retrieval/definitions';
import { supabase, supabaseAnonKey, supabaseUrl } from '../../lib/supabase';
import { startIngestWorker } from './ingestRunner';
import {
  computePreparedFingerprint,
  countReviewPages,
  durablePreparation,
  readPreparationState,
  writePreparationState,
  type DurablePreparation,
  type PreparationState,
  type PreparationStage,
} from './preparationState';

export interface PreparationOptions {
  db?: HarnessDBHandle;
  // Re-run ingestion even when the document is already ready (used by "Recheck" and
  // after a review decision on a ready document).
  forceIngest?: boolean;
  // Re-OCR pages without a saved decision (decisions always win). Implies forceIngest.
  recheck?: boolean;
  // Re-run the definitions sheet even when a matching sheet exists (used by "Retry").
  forceDefinitions?: boolean;
  onEvent?: (state: PreparationState) => void;
}

// One preparation per tab. The orchestrator lives outside React so navigating between
// app routes does not stop it. The per-document Web Lock still blocks another tab.
let activeDocId: string | null = null;
let activeState: PreparationState | null = null;
let activeClient: RetrievalClient | null = null;
const listeners = new Set<(state: PreparationState) => void>();

export function getActiveDocId(): string | null {
  return activeDocId;
}

export function getPreparationState(): PreparationState | null {
  return activeState;
}

export function subscribePreparation(listener: (state: PreparationState) => void): () => void {
  listeners.add(listener);
  if (activeState) listener(activeState);
  return () => {
    listeners.delete(listener);
  };
}

function emit(state: PreparationState): void {
  state.updatedAt = Date.now();
  activeState = { ...state };
  writePreparationState(activeState);
  for (const listener of listeners) listener(activeState);
}

function makeState(docId: string): PreparationState {
  return {
    docId,
    stage: 'ingest',
    completedStages: [],
    docPrepFingerprint: null,
    progress: null,
    message: null,
    review: null,
    failed: null,
    preparedAt: null,
    preparedFingerprint: null,
    updatedAt: Date.now(),
  };
}

function markCompleted(state: PreparationState, stage: PreparationStage): void {
  if (!state.completedStages.includes(stage)) state.completedStages.push(stage);
}

function reconcileCompleted(state: PreparationState, doc: DocumentRecord, durable: DurablePreparation): PreparationStage[] {
  // A changed document fingerprint means the previous stages are stale.
  if (state.docPrepFingerprint && state.docPrepFingerprint !== doc.prepFingerprint) return [];
  const completed = new Set(state.completedStages);
  if (durable.hasChunks) completed.add('ingest');
  if (durable.embeddingsReady) completed.add('embeddings');
  if (durable.definitionsReady) completed.add('definitions');
  return [...completed];
}

function nextStage(state: PreparationState, doc: DocumentRecord, durable: DurablePreparation): PreparationStage {
  if (doc.status === 'review') return 'needs-review';
  if (!durable.hasChunks) return 'ingest';
  if (!durable.embeddingsReady) return 'embeddings';
  if (!state.completedStages.includes('index')) return 'index';
  if (!durable.definitionsReady) return 'definitions';
  return 'ready';
}

// A document that is already prepared in the harness reaches Ready without redoing work.
async function ensureReadyState(
  doc: DocumentRecord,
  durable: DurablePreparation,
): Promise<PreparationState> {
  const existing = readPreparationState(doc.id);
  const fingerprint = await computePreparedFingerprint(doc);
  if (existing && existing.stage === 'ready' && existing.preparedFingerprint === fingerprint && existing.preparedAt) {
    return existing;
  }
  const state: PreparationState = {
    docId: doc.id,
    stage: 'ready',
    completedStages: ['ingest', 'embeddings', 'index', 'definitions'],
    docPrepFingerprint: doc.prepFingerprint,
    progress: null,
    message: null,
    review: null,
    failed: null,
    preparedAt: Math.max(durable.embeddingsAt ?? 0, durable.definitionsAt ?? 0, Date.now()),
    preparedFingerprint: fingerprint,
    updatedAt: Date.now(),
  };
  emit(state);
  return state;
}

export async function runPreparation(docId: string, opts: PreparationOptions = {}): Promise<PreparationState> {
  const db = opts.db ?? (await openHarnessDb());
  const doc = await db.get('documents', docId);
  if (!doc) throw new Error(`Document ${docId} not found.`);

  const durable = await durablePreparation(db, doc);
  const existing = readPreparationState(docId);

  // A failed document is not "ready": the user asked to Retry, so run the stages again.
  if (durable.prepared && existing?.stage !== 'failed' && !opts.forceDefinitions && !opts.forceIngest && !opts.recheck) {
    const state = await ensureReadyState(doc, durable);
    opts.onEvent?.(state);
    return state;
  }

  if (activeDocId) {
    if (activeDocId === docId) return activeState ?? readPreparationState(docId) ?? makeState(docId);
    throw new Error('Another document is being prepared in this tab. Wait for it to finish first.');
  }

  activeDocId = docId;
  const state = readPreparationState(docId) ?? makeState(docId);
  const previousFailed = state.failed?.stage ?? null;
  state.docPrepFingerprint = doc.prepFingerprint;
  state.completedStages = reconcileCompleted(state, doc, durable);
  state.stage = nextStage(state, doc, durable);
  state.progress = null;
  state.message = null;
  state.review = null;
  state.failed = null;
  emit(state);
  opts.onEvent?.(activeState!);

  try {
    await navigator.locks.request(`doc:${doc.hash}`, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('This document is already being prepared in another tab.');
      await runStages(db, doc, state, opts, previousFailed);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedStage = state.stage === 'ready' ? 'definitions' : state.stage;
    state.stage = 'failed';
    state.failed = { stage: failedStage, message };
    state.progress = null;
    state.message = message;
    emit(state);
    opts.onEvent?.(activeState!);
    throw error;
  } finally {
    activeDocId = null;
    activeClient?.dispose();
    activeClient = null;
  }

  return state;
}

async function runStages(
  db: HarnessDBHandle,
  initialDoc: DocumentRecord,
  state: PreparationState,
  opts: PreparationOptions,
  previousFailed: PreparationStage | null,
): Promise<void> {
  let doc = initialDoc;

  // 1. Ingestion (extraction, OCR, page decisions, chunking). Chunking is already
  // part of finalize, so it is not a separate stage.
  if (doc.status !== 'ready' || opts.forceIngest || opts.recheck) {
    state.stage = 'ingest';
    state.completedStages = state.completedStages.filter((s) => s !== 'ingest');
    state.progress = { done: 0, total: 0 };
    state.message = 'Extracting text and running OCR…';
    emit(state);
    await runIngest(doc, state, Boolean(opts.recheck));

    const fresh = await db.get('documents', doc.id);
    if (!fresh) throw new Error('The document disappeared during ingestion.');
    doc = fresh;
    if (fresh.status === 'review') {
      state.stage = 'needs-review';
      state.review = { pages: await countReviewPages(db, doc.id) };
      state.progress = null;
      state.message = null;
      emit(state);
      return;
    }
    if (fresh.status !== 'ready') throw new Error(`Ingestion did not finish (status: ${fresh.status}).`);
    markCompleted(state, 'ingest');
  } else {
    markCompleted(state, 'ingest');
  }

  // 2. Embeddings. The existing worker skips windows that are already stored and
  // re-embeds when the model version or preparation fingerprint changed.
  const afterIngest = await durablePreparation(db, doc);
  if (afterIngest.embeddingsReady) {
    markCompleted(state, 'embeddings');
  } else {
    state.stage = 'embeddings';
    state.completedStages = state.completedStages.filter((s) => s !== 'embeddings');
    state.progress = { done: 0, total: 0 };
    state.message = 'Embedding chunks…';
    emit(state);
    await runEmbeddings(doc, state);
    markCompleted(state, 'embeddings');
  }

  // 3. Keyword index. The existing retrieval worker builds MiniSearch on demand; a
  // search call warms it. The index is not persisted, so it is recorded in the
  // wrapper state rather than in a new store.
  if (state.completedStages.includes('index')) {
    // Already warmed in this run.
  } else {
    state.stage = 'index';
    state.progress = null;
    state.message = 'Building the keyword index…';
    emit(state);
    await runIndex(doc, state);
    markCompleted(state, 'index');
  }

  // 4. Definitions sheet. The existing definitions task writes the definitions store.
  const afterEmbeddings = await durablePreparation(db, doc);
  const defsReady = afterEmbeddings.definitionsReady && previousFailed !== 'definitions';
  if (defsReady) {
    markCompleted(state, 'definitions');
  } else {
    state.stage = 'definitions';
    state.completedStages = state.completedStages.filter((s) => s !== 'definitions');
    state.progress = null;
    state.message = 'Building the definitions sheet…';
    emit(state);
    await runDefinitions(db, doc, state);
    markCompleted(state, 'definitions');
  }

  // 5. Ready. The stored stamp includes the embedding model version.
  state.stage = 'ready';
  state.progress = null;
  state.message = null;
  state.review = null;
  state.failed = null;
  state.preparedAt = Date.now();
  state.preparedFingerprint = await computePreparedFingerprint(doc);
  emit(state);
}

async function runIngest(doc: DocumentRecord, state: PreparationState, recheck: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    startIngestWorker(doc.id, (event) => {
      switch (event.type) {
        case 'progress':
          state.progress = { done: event.done, total: event.total };
          state.message = `Extracting and OCR: ${event.done}/${event.total} pages`;
          emit(state);
          break;
        case 'finished':
          // The final status is read from the document after the worker goes idle.
          break;
        case 'locked':
          reject(new Error('This document is already being processed in another tab.'));
          break;
        case 'error':
          reject(new Error(event.message));
          break;
        case 'idle':
          resolve();
          break;
      }
    }, { recheck });
  });
}

async function runEmbeddings(doc: DocumentRecord, state: PreparationState): Promise<void> {
  const client = new RetrievalClient((event) => {
    if (event.type === 'model-loading') {
      state.message = 'Loading the embedding model…';
      emit(state);
    } else if (event.type === 'embed-progress') {
      state.progress = { done: event.done as number, total: event.total as number };
      state.message = `Embedding ${event.done}/${event.total} windows`;
      emit(state);
    }
  });
  activeClient = client;
  try {
    await client.embed(doc.id);
  } finally {
    client.dispose();
    activeClient = null;
  }
}

async function runIndex(doc: DocumentRecord, state: PreparationState): Promise<void> {
  const client = new RetrievalClient((event) => {
    if (event.type === 'model-loading') {
      state.message = 'Building the keyword index…';
      emit(state);
    }
  });
  activeClient = client;
  try {
    await client.search(doc.id, 'preparation', 1);
  } finally {
    client.dispose();
    activeClient = null;
  }
}

async function runDefinitions(db: HarnessDBHandle, doc: DocumentRecord, state: PreparationState): Promise<void> {
  const sb = supabase;
  if (!sb) throw new Error('Supabase is not configured.');
  const { data: sessionData } = await sb.auth.getSession();
  const session = sessionData.session;
  if (!session) throw new Error('Sign in to build the definitions sheet.');

  const refreshAccessToken = async (force = false): Promise<string | null> => {
    if (force) {
      const { data, error } = await sb.auth.refreshSession();
      if (!error && data.session) return data.session.access_token;
    }
    const { data } = await sb.auth.getSession();
    return data.session?.access_token ?? null;
  };

  const model =
    (import.meta.env.VITE_SEARCH_MODEL as string) || (import.meta.env.VITE_MODEL as string) || 'deepseek/deepseek-v4.1-flash';
  const fallback = (import.meta.env.VITE_FALLBACK_MODEL as string) || null;

  try {
    const out = await buildDefinitionsSheet({
      db,
      supabase: sb,
      accessToken: session.access_token,
      refreshAccessToken,
      userId: session.user.id,
      docId: doc.id,
      model,
      fallbackModel: fallback,
      functionsUrl: `${supabaseUrl}/functions/v1`,
      anonKey: supabaseAnonKey,
      reasoning: { effort: 'minimal' },
      onProgress: (message) => {
        state.message = message;
        emit(state);
      },
    });
    if (out.failed > 0) {
      throw new Error(`Definitions sheet finished with ${out.failed} failed task(s).`);
    }
  } catch (error) {
    // A document with no definition or party text is a valid prepared document.
    // The existing task throws; the library stores an empty sheet so the document can
    // reach Ready instead of failing permanently.
    if (error instanceof Error && error.message === 'no definition or party text found in this document') {
      await db.put('definitions', {
        docId: doc.id,
        prepFingerprint: doc.prepFingerprint!,
        sheet: { parties: [], defined_terms: [], key_dates: [], sources: [] },
        updatedAt: Date.now(),
      });
      state.message = 'No definitions or party text found; saved an empty sheet.';
      emit(state);
      return;
    }
    throw error;
  }
}
