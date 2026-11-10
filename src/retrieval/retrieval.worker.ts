import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import MiniSearch from 'minisearch';
import { openHarnessDb, deleteEmbeddingsForDoc, type HarnessDBHandle, type ChunkRecord, type EmbeddingWindowRecord, type DocumentRecord } from '../runner/db';
import { buildWindows } from './windows';
import { tokenize } from './tokenize';
import { rrfFuse, filterWeak, type Ranked } from './fusion';
import {
  EMBED_DIM,
  EMBED_MODEL_DTYPE,
  EMBED_MODEL_ID,
  EMBED_MODEL_VERSION,
  MIN_RELATIVE_SCORE,
  PASSAGE_PREFIX,
  QUERY_PREFIX,
  WINDOW_MAX_TOKENS,
} from './config';
import { needsReembed } from './modelVersion';
import { LAW_PASSAGES, LAW_VERSION } from './lawSearch';

const ctx = self as unknown as { postMessage: (m: unknown) => void; onmessage: ((e: MessageEvent) => void) | null };
let activeRequestId: string | undefined;
const post = (m: unknown) => ctx.postMessage({ ...(m as Record<string, unknown>), requestId: activeRequestId });

let extractor: Promise<FeatureExtractionPipeline> | null = null;

async function model(): Promise<any> {
  if (!extractor) {
    env.allowLocalModels = false;
    post({ type: 'model-loading', model: EMBED_MODEL_ID });
    extractor = pipeline('feature-extraction', EMBED_MODEL_ID, { dtype: EMBED_MODEL_DTYPE }) as Promise<FeatureExtractionPipeline>;
  }
  return extractor;
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await model();
  const out = await pipe(texts, { pooling: 'mean', normalize: true });
  const rows: number[][] = out.tolist();
  return rows.map((r) => Float32Array.from(r));
}

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

const keywordIndexes = new Map<string, MiniSearch>();
const chunkCache = new Map<string, Map<string, ChunkRecord>>();

async function chunksFor(db: HarnessDBHandle, docId: string): Promise<Map<string, ChunkRecord>> {
  const cached = chunkCache.get(docId);
  if (cached) return cached;
  const all = await db.getAll('chunks', IDBKeyRange.bound(`${docId}:`, `${docId}:\uffff`));
  const map = new Map(all.map((c) => [c.id, c]));
  chunkCache.set(docId, map);
  return map;
}

interface EmbedMessage {
  type: 'embed';
  docId: string;
}
interface SearchMessage {
  type: 'search';
  docId: string;
  query: string;
  k: number;
}
interface LawSearchMessage {
  type: 'law-search';
  text: string;
  k: number;
}
interface StatusMessage {
  type: 'status';
  docId: string;
}
type InMessage = EmbedMessage | SearchMessage | LawSearchMessage | StatusMessage;

ctx.onmessage = (e: MessageEvent<InMessage>) => {
  void handle(e.data);
};

async function handle(msg: InMessage) {
  activeRequestId = (msg as { requestId?: string }).requestId;
  try {
    const db = await openHarnessDb();
    if (msg.type === 'embed') await embedDoc(db, msg.docId);
    else if (msg.type === 'search') await searchDoc(db, msg.docId, msg.query, msg.k);
    else if (msg.type === 'law-search') await searchLaw(db, msg.text, msg.k);
    else if (msg.type === 'status') {
      const state = await db.get('embedding_state', msg.docId);
      post({ type: 'status', docId: msg.docId, state: state ?? null, modelVersion: EMBED_MODEL_VERSION });
    }
  } catch (err) {
    post({ type: 'error', message: String(err) });
  }
}

async function embedDoc(db: HarnessDBHandle, docId: string) {
  const doc: DocumentRecord | undefined = await db.get('documents', docId);
  if (!doc) throw new Error(`no document ${docId}`);
  if (doc.status !== 'ready' || !doc.prepFingerprint) throw new Error(`document ${docId} is not ready`);

  const state = await db.get('embedding_state', docId);
  const current = { model: EMBED_MODEL_ID, modelVersion: EMBED_MODEL_VERSION, dim: EMBED_DIM, prepFingerprint: doc.prepFingerprint };
  if (needsReembed(state, current)) {
    await deleteEmbeddingsForDoc(db, docId);
  }

  const chunks = await chunksFor(db, docId);
  const work: { key: string; chunkId: string; windowIndex: number; text: string; start: number; end: number; tokenEst: number }[] = [];
  for (const chunk of chunks.values()) {
    for (const w of buildWindows(chunk.text, WINDOW_MAX_TOKENS)) {
      const key = `${docId}|${chunk.id}|${w.windowIndex}`;
      work.push({ key, chunkId: chunk.id, windowIndex: w.windowIndex, text: w.text, start: w.start, end: w.end, tokenEst: w.tokenEst });
    }
  }

  const existing = new Set(await db.getAllKeys('embedding_windows', IDBKeyRange.bound(`${docId}|`, `${docId}|\uffff`)));
  const pending = work.filter((w) => !existing.has(w.key));
  post({ type: 'embed-progress', docId, done: work.length - pending.length, total: work.length, resumed: work.length - pending.length });

  const BATCH = 8;
  let done = work.length - pending.length;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vectors = await embed(batch.map((b) => PASSAGE_PREFIX + b.text));
    const tx = db.transaction('embedding_windows', 'readwrite');
    batch.forEach((b, j) => {
      const record: EmbeddingWindowRecord = {
        key: b.key,
        docId,
        chunkId: b.chunkId,
        windowIndex: b.windowIndex,
        text: b.text,
        start: b.start,
        end: b.end,
        tokenEst: b.tokenEst,
        model: EMBED_MODEL_ID,
        modelVersion: EMBED_MODEL_VERSION,
        dim: vectors[j].length,
        prepFingerprint: doc.prepFingerprint!,
        vector: vectors[j],
      };
      tx.store.put(record);
    });
    await tx.done;
    done += batch.length;
    post({ type: 'embed-progress', docId, done, total: work.length });
  }

  await db.put('embedding_state', {
    docId,
    model: EMBED_MODEL_ID,
    modelVersion: EMBED_MODEL_VERSION,
    dim: EMBED_DIM,
    prepFingerprint: doc.prepFingerprint,
    windowsTotal: work.length,
    completedAt: Date.now(),
  });
  post({ type: 'embed-done', docId, windows: work.length });
}

async function docWindows(db: HarnessDBHandle, docId: string, prepFingerprint: string): Promise<EmbeddingWindowRecord[]> {
  const all = await db.getAll('embedding_windows', IDBKeyRange.bound(`${docId}|`, `${docId}|\uffff`));
  return all.filter((w) => w.prepFingerprint === prepFingerprint && w.modelVersion === EMBED_MODEL_VERSION);
}

function keywordFor(cacheKey: string, windows: { key: string; text: string }[]): MiniSearch {
  const cached = keywordIndexes.get(cacheKey);
  if (cached) return cached;
  const ms = new MiniSearch({
    idField: 'id',
    fields: ['text'],
    storeFields: ['chunkId'],
    tokenize,
    searchOptions: { tokenize, prefix: true, fuzzy: 0.1 },
  });
  ms.addAll(windows.map((w) => ({ id: w.key, text: w.text })));
  keywordIndexes.set(cacheKey, ms);
  return ms;
}

async function searchDoc(db: HarnessDBHandle, docId: string, query: string, k: number) {
  const doc = await db.get('documents', docId);
  if (!doc?.prepFingerprint) throw new Error('document is not ready');
  const windows = await docWindows(db, docId, doc.prepFingerprint);
  if (windows.length === 0) {
    post({ type: 'search-results', docId, query, results: [] });
    return;
  }
  const chunks = await chunksFor(db, docId);
  const [qv] = await embed([QUERY_PREFIX + query]);
  const vecRanked: Ranked[] = windows
    .map((w) => ({ id: w.key, score: dot(qv, w.vector) }))
    .sort((a, b) => b.score - a.score);

  const kwRanked: Ranked[] = keywordFor(`${docId}|${doc.prepFingerprint}`, windows)
    .search(query)
    .map((r) => ({ id: String(r.id), score: r.score }));
  const fused = rrfFuse([vecRanked, kwRanked.slice(0, 50)]);
  const ranked: Ranked[] = [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);

  const byKey = new Map(windows.map((w) => [w.key, w]));
  const vecScore = new Map(vecRanked.map((r) => [r.id, r.score]));
  const kwScore = new Map(kwRanked.map((r) => [r.id, r.score]));

  const best = new Map<string, { window: EmbeddingWindowRecord; fused: number }>();
  for (const r of filterWeak(ranked, MIN_RELATIVE_SCORE).slice(0, k * 4)) {
    const w = byKey.get(r.id);
    if (!w) continue;
    const prev = best.get(w.chunkId);
    if (!prev || r.score > prev.fused) best.set(w.chunkId, { window: w, fused: r.score });
  }

  const results = [...best.entries()]
    .sort((a, b) => b[1].fused - a[1].fused)
    .slice(0, k)
    .map(([chunkId, v]) => {
      const c = chunks.get(chunkId);
      return {
        chunkId,
        pageStart: c?.pageStart ?? 0,
        pageEnd: c?.pageEnd ?? 0,
        clauseFrom: c?.clauseFrom ?? null,
        clauses: c?.clauses ?? [],
        heading: c?.heading ?? null,
        windowText: v.window.text,
        fused: v.fused,
        vectorScore: vecScore.get(v.window.key) ?? 0,
        keywordScore: kwScore.get(v.window.key) ?? 0,
      };
    });

  post({ type: 'search-results', docId, query, results });
}

let lawVectors: { id: string; text: string; title: string; vector: Float32Array }[] | null = null;

async function ensureLawVectors() {
  if (lawVectors) return lawVectors;
  const vecs = await embed(LAW_PASSAGES.map((p) => PASSAGE_PREFIX + p.title + '. ' + p.text));
  lawVectors = LAW_PASSAGES.map((p, i) => ({ id: p.id, title: p.title, text: p.text, vector: vecs[i] }));
  return lawVectors;
}

async function searchLaw(_db: HarnessDBHandle, text: string, k: number) {
  const vectors = await ensureLawVectors();
  const [qv] = await embed([QUERY_PREFIX + text]);
  const vecRanked: Ranked[] = vectors
    .map((p) => ({ id: p.id, score: dot(qv, p.vector) }))
    .sort((a, b) => b.score - a.score);

  const ms = new MiniSearch({
    idField: 'id',
    fields: ['title', 'text'],
    storeFields: ['title', 'text'],
    tokenize,
    searchOptions: { tokenize, prefix: true, fuzzy: 0.1, boost: { title: 2 } },
  });
  ms.addAll(LAW_PASSAGES.map((p) => ({ ...p })));
  const kwRanked: Ranked[] = ms.search(text).map((r) => ({ id: String(r.id), score: r.score }));

  const fused = [...rrfFuse([vecRanked, kwRanked]).entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
  const byId = new Map(vectors.map((v) => [v.id, v]));
  const vecScore = new Map(vecRanked.map((r) => [r.id, r.score]));

  const results = filterWeak(fused, MIN_RELATIVE_SCORE)
    .slice(0, k)
    .map((r) => {
      const p = byId.get(r.id)!;
      return {
        id: p.id,
        title: p.title,
        text: p.text,
        fused: r.score,
        vectorScore: vecScore.get(p.id) ?? 0,
        lawVersion: LAW_VERSION,
      };
    });

  post({ type: 'law-results', text, results });
}
