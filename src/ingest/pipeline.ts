import type { HarnessDBHandle, PageRecord, PageStatus, DocumentRecord, ChunkRecord, OcrDecision } from '../runner/db';
import { FINAL_PAGE_STATUSES, deleteEmbeddingsForDoc } from '../runner/db';
import { sha256Hex } from '../tasks/fingerprint';
import { openPdf, closePdf, extractNativePage, renderPageInto, type PdfDoc } from './pdfPages';
import { assessNativeText, renderProblem } from './quality';
import { checkOcrOutput, type OcrLang } from './ocrCheck';
import { OCR_PLAN, chooseBestAttempt, shouldStop, type OcrAttempt } from './ocrPlan';
import { preprocessCanvas } from './ocrPreprocess';
import { OcrEngine } from './ocr';
import { DEFAULT_CHUNK_CONFIG } from './chunk';
import { chunkDocumentWithConfidence } from './chunkQuality';

export const EXTRACTOR_VERSION = 'pdfjs-v1+tesseract-v1';
const BATCH_PAGES = 5;

export type IngestEvent =
  | { type: 'progress'; done: number; total: number; skipped: number; stage: string }
  | { type: 'page'; pageNo: number; status: PageStatus; reason: string | null }
  | { type: 'finished'; status: DocumentRecord['status']; review: number; chunks: number; prepFingerprint: string | null }
  | { type: 'error'; message: string; stack?: string };

export interface PipelineDeps {
  db: HarnessDBHandle;
  emit: (event: IngestEvent) => void;
}

export function parseLangs(ocrLangs: string): OcrLang[] {
  return ocrLangs.split('+').filter((l): l is OcrLang => l === 'eng' || l === 'mar' || l === 'hin');
}

function pageRange(docId: string): IDBKeyRange {
  return IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]);
}

async function loadPdf(db: HarnessDBHandle, docId: string): Promise<{ doc: DocumentRecord; pdf: PdfDoc }> {
  const doc = await db.get('documents', docId);
  if (!doc?.pdf) throw new Error(`document ${docId} has no PDF stored`);
  const pdf = await openPdf(await doc.pdf.arrayBuffer());
  return { doc, pdf };
}

interface OcrOutcome {
  text: string;
  status: PageStatus;
  source: PageRecord['source'];
  reason: string | null;
  dpi: number | null;
  ocrConfidence?: number | null;
  ocrWords?: number | null;
  ocrPsm?: string | null;
}

async function ocrPage(
  pdf: PdfDoc,
  pageNo: number,
  ocr: OcrEngine,
  langs: OcrLang[],
  canvas: OffscreenCanvas,
  imageCount: number,
): Promise<OcrOutcome> {
  const attempts: OcrAttempt[] = [];
  let renderedDpi = 0;
  let renderedInk = 0;
  for (const step of OCR_PLAN) {
    if (step.dpi !== renderedDpi) {
      const rendered = await renderPageInto(pdf, pageNo, step.dpi, canvas);
      renderedDpi = step.dpi;
      renderedInk = rendered.inkRatio;
    }
    const problem = renderProblem(renderedInk, imageCount);
    if (problem) {
      return { text: '', status: 'review', source: null, reason: problem, dpi: step.dpi };
    }
    try {
      const input = preprocessCanvas(canvas, step.mode);
      const out = await ocr.recognize(input, { psm: step.psm, dpi: step.dpi });
      const check = checkOcrOutput(out.text, langs);
      attempts.push({
        text: out.text,
        confidence: out.confidence,
        dpi: step.dpi,
        psm: step.psm,
        mode: step.mode,
        check,
      });
      if (shouldStop(attempts)) break;
    } catch {
      // One segmentation/preprocessing attempt failing must not fail the page.
      continue;
    }
  }

  const best = chooseBestAttempt(attempts);
  if (!best) {
    return { text: '', status: 'review', source: 'ocr', reason: 'no_text', dpi: null };
  }
  const ok = best.check.ok;
  return {
    text: best.text,
    status: ok ? 'ocr' : 'review',
    source: 'ocr',
    reason: ok ? null : best.check.reason,
    dpi: best.dpi,
    ocrConfidence: best.confidence,
    ocrWords: best.check.words,
    ocrPsm: best.psm,
  };
}

async function processPage(
  deps: PipelineDeps,
  pdf: PdfDoc,
  docId: string,
  pageNo: number,
  ocr: OcrEngine,
  langs: OcrLang[],
  canvas: OffscreenCanvas,
): Promise<PageRecord> {
  const { db } = deps;
  const now = Date.now();
  const native = await extractNativePage(pdf, pageNo);
  const base = { docId, pageNo, nativeChars: native.text.trim().length, imageCount: native.imageCount, updatedAt: now };

  const decision: OcrDecision | undefined = await db.get('ocr_decisions', [docId, pageNo]);
  if (decision) {
    if (decision.decision === 'blank') {
      return { ...base, text: '', status: 'blank', source: 'manual', reason: null, dpi: null };
    }
    if (decision.decision === 'unresolved') {
      const prev = await db.get('pages', [docId, pageNo]);
      return {
        ...base,
        text: prev?.text ?? native.text,
        status: 'review',
        source: prev?.source ?? null,
        reason: 'unresolved',
        dpi: prev?.dpi ?? null,
      };
    }
    return { ...base, text: decision.text, status: 'accepted', source: 'manual', reason: null, dpi: null };
  }

  const quality = assessNativeText(native.text, native.imageCount);
  if (quality.verdict === 'native') {
    return { ...base, text: native.text, status: 'native', source: 'native', reason: null, dpi: null };
  }
  if (quality.verdict === 'blank_candidate') {
    return { ...base, text: '', status: 'review', source: null, reason: 'blank_candidate', dpi: null };
  }
  const outcome = await ocrPage(pdf, pageNo, ocr, langs, canvas, native.imageCount);
  return { ...base, ...outcome };
}

async function writePages(db: HarnessDBHandle, records: PageRecord[]): Promise<void> {
  if (records.length === 0) return;
  const tx = db.transaction('pages', 'readwrite');
  for (const r of records) await tx.store.put(r, [r.docId, r.pageNo]);
  await tx.done;
}

async function prepFingerprint(docHash: string, ocrLangs: string, pages: PageRecord[], chunkMode = 'structure'): Promise<string> {
  // Chunk sizes and mode are part of the fingerprint: changing them rebuilds chunks and embeddings.
  const rows: unknown[] = [
    EXTRACTOR_VERSION,
    docHash,
    ocrLangs,
    `chunk:${DEFAULT_CHUNK_CONFIG.targetTokens}/${DEFAULT_CHUNK_CONFIG.maxTokens}/${DEFAULT_CHUNK_CONFIG.minTokens}:${chunkMode}`,
  ];
  for (const p of pages) rows.push([p.pageNo, p.status, await sha256Hex(p.text)]);
  return sha256Hex(JSON.stringify(rows));
}

export async function ingestDocument(deps: PipelineDeps, docId: string, opts: { recheck?: boolean } = {}): Promise<void> {
  const { db, emit } = deps;
  const { doc, pdf } = await loadPdf(db, docId);
  const total = pdf.numPages;
  const langs = parseLangs(doc.ocrLangs);
  const ocr = new OcrEngine(doc.ocrLangs);
  const canvas = new OffscreenCanvas(1, 1);

  await db.put('documents', { ...doc, status: 'processing', pageCount: total });

  const saved = new Map<number, PageRecord>();
  for (const p of await db.getAll('pages', pageRange(docId))) saved.set(p.pageNo, p);

  let batch: PageRecord[] = [];
  let skipped = 0;
  try {
    for (let pageNo = 1; pageNo <= total; pageNo++) {
      if (saved.has(pageNo) && !opts.recheck) {
        skipped++;
      } else {
        const record = await processPage(deps, pdf, docId, pageNo, ocr, langs, canvas);
        batch.push(record);
        emit({ type: 'page', pageNo, status: record.status, reason: record.reason });
        if (batch.length >= BATCH_PAGES) {
          await writePages(db, batch);
          batch = [];
        }
      }
      emit({ type: 'progress', done: pageNo, total, skipped, stage: 'extract+ocr' });
    }
    await writePages(db, batch);
  } finally {
    await ocr.terminate();
    await closePdf(pdf);
  }
  await finalize(deps, docId);
}

async function finalize(deps: PipelineDeps, docId: string): Promise<void> {
  const { db, emit } = deps;
  const doc = await db.get('documents', docId);
  if (!doc) throw new Error(`document ${docId} disappeared`);
  const pages = (await db.getAll('pages', pageRange(docId))).sort((a, b) => a.pageNo - b.pageNo);
  const complete = pages.length === doc.pageCount && pages.every((p) => FINAL_PAGE_STATUSES.includes(p.status));
  const review = pages.filter((p) => !FINAL_PAGE_STATUSES.includes(p.status)).length;

  if (!complete) {
    await db.put('documents', { ...doc, status: 'review' });
    emit({ type: 'finished', status: 'review', review, chunks: 0, prepFingerprint: null });
    return;
  }

  const chunking = chunkDocumentWithConfidence(pages.map((p) => ({ pageNo: p.pageNo, text: p.text })));
  const chunks = chunking.chunks;
  const prep = await prepFingerprint(doc.hash, doc.ocrLangs, pages, chunking.mode);
  const records: ChunkRecord[] = chunks.map((c) => ({ ...c, id: `${docId}:${c.index}`, docId, prepFingerprint: prep }));
  const previousPrep = doc.prepFingerprint;

  const tx = db.transaction(['chunks', 'documents'], 'readwrite');
  const store = tx.objectStore('chunks');
  await store.delete(IDBKeyRange.bound(`${docId}:`, `${docId}:\uffff`));
  for (const r of records) await store.put(r);
  await tx.objectStore('documents').put({
    ...doc,
    status: 'ready',
    pageCount: pages.length,
    prepFingerprint: prep,
    chunkCount: records.length,
    chunkMode: chunking.mode,
    chunkModeReason: chunking.modeReason,
  });
  await tx.done;

  // A changed preparation (pages, OCR decisions or chunk sizes) invalidates stored vectors.
  if (previousPrep !== prep) await deleteEmbeddingsForDoc(db, docId);

  emit({ type: 'finished', status: 'ready', review: 0, chunks: records.length, prepFingerprint: prep });
}

export async function reocrPage(deps: PipelineDeps, docId: string, pageNo: number): Promise<void> {
  const { db, emit } = deps;
  const { doc, pdf } = await loadPdf(db, docId);
  const langs = parseLangs(doc.ocrLangs);
  const ocr = new OcrEngine(doc.ocrLangs);
  const canvas = new OffscreenCanvas(1, 1);
  try {
    const native = await extractNativePage(pdf, pageNo);
    const outcome = await ocrPage(pdf, pageNo, ocr, langs, canvas, native.imageCount);
    await writePages(db, [
      {
        docId,
        pageNo,
        nativeChars: native.text.trim().length,
        imageCount: native.imageCount,
        updatedAt: Date.now(),
        ...outcome,
      },
    ]);
    emit({ type: 'page', pageNo, status: outcome.status, reason: outcome.reason });
  } finally {
    await ocr.terminate();
    await closePdf(pdf);
  }
  await finalize(deps, docId);
}
