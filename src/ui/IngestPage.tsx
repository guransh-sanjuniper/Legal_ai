import { useEffect, useRef, useState } from 'react';
import { openHarnessDb, FINAL_PAGE_STATUSES, type HarnessDBHandle, type DocumentRecord, type PageRecord, type ChunkRecord } from '../runner/db';
import { sha256Bytes } from '../ingest/hash';
import { requestPersistence, storageReport, type StorageReport } from '../ingest/storage';
import { openPdf, renderPageInto, closePdf, type PdfDoc } from '../ingest/pdfPages';
import type { IngestMessage } from '../ingest/ingest.worker';
import type { IngestEvent } from '../ingest/pipeline';
import { checkChunks } from '../ingest/checkChunks';
import { chunkDocumentWithConfidence } from '../ingest/chunkQuality';
import { DEFAULT_CHUNK_CONFIG } from '../ingest/chunk';
import type { ChunkCheck } from '../ingest/checkChunks';
import { PageNav } from './PageNav';

const LANG_OPTIONS = ['eng', 'eng+mar', 'eng+hin', 'eng+mar+hin'];
const reasonLabel = (reason: string | null) =>
  reason === 'render_decode_failed'
    ? 'images present but render is blank — check pdf.js wasm assets'
    : reason;
const MB = (n: number) => (n / 1048576).toFixed(1) + ' MB';

export function IngestPage() {
  const [db, setDb] = useState<HarnessDBHandle | null>(null);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pages, setPages] = useState<PageRecord[]>([]);
  const [chunks, setChunks] = useState<ChunkRecord[]>([]);
  const [analysisCheck, setAnalysisCheck] = useState<ChunkCheck | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; skipped: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [reviewPageNo, setReviewPageNo] = useState<number | null>(null);
  const [correction, setCorrection] = useState('');
  const [busy, setBusy] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugPageNo, setDebugPageNo] = useState<number | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfRef = useRef<{ docId: string; pdf: PdfDoc } | null>(null);

  const addLog = (line: string) => setLog((l) => [...l.slice(-60), `${new Date().toLocaleTimeString()} ${line}`]);

  useEffect(() => {
    openHarnessDb().then(setDb);
  }, []);

  useEffect(() => {
    if (!db) return;
    const refresh = async () => {
      setDocs((await db.getAll('documents')).sort((a, b) => b.createdAt - a.createdAt));
      if (selectedId) {
        const all = await db.getAll('pages', IDBKeyRange.bound([selectedId, 0], [selectedId, Number.MAX_SAFE_INTEGER]));
        setPages(all.sort((a, b) => a.pageNo - b.pageNo));
        const doc = await db.get('documents', selectedId);
        if (doc?.status === 'ready') {
          const cs = await db.getAll('chunks', IDBKeyRange.bound(`${selectedId}:`, `${selectedId}:\uffff`));
          // Rows written before clauses/startKind existed are normalised so the checker can read them.
          setChunks(
            cs
              .map((c) => ({
                ...c,
                clauses: c.clauses ?? (c.clauseFrom ? [c.clauseFrom] : []),
                startKind: c.startKind ?? 'clause',
                sectionBreak: c.sectionBreak ?? false,
                unusuallyLong: c.unusuallyLong ?? false,
                pageMarkedText: c.pageMarkedText ?? c.text,
              }))
              .sort((a, b) => a.index - b.index),
          );
        } else {
          setChunks([]);
        }
      }
    };
    refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [db, selectedId]);

  useEffect(() => {
    requestPersistence().then(setPersisted);
  }, []);

  // Switching documents must not leave a review panel (and its edited text) pointing at the old one.
  useEffect(() => {
    setReviewPageNo(null);
    setCorrection('');
  }, [selectedId]);

  const selected = docs.find((d) => d.id === selectedId) ?? null;

  async function onFile(file: File) {
    if (!db) return;
    const buf = await file.arrayBuffer();
    const hash = await sha256Bytes(buf);
    const report = await storageReport(file.size);
    setStorage(report);
    if (!report.fits) addLog(`WARNING: ${file.name} needs about ${MB(report.neededBytes)} free, only ${MB(report.free)} available`);
    const existing = await db.get('documents', hash);
    if (!existing) {
      await db.put('documents', {
        id: hash,
        name: file.name,
        hash,
        size: file.size,
        pdf: new Blob([buf], { type: 'application/pdf' }),
        createdAt: Date.now(),
        status: 'new',
        ocrLangs: 'eng',
        pageCount: 0,
        prepFingerprint: null,
        chunkCount: 0,
      });
      addLog(`stored ${file.name} (${MB(file.size)}) as ${hash.slice(0, 12)}`);
    } else {
      addLog(`${file.name} already stored`);
    }
    setSelectedId(hash);
  }

  async function setLangs(langs: string) {
    if (!db || !selected) return;
    await db.put('documents', { ...selected, ocrLangs: langs });
  }

  function post(msg: IngestMessage) {
    if (workerRef.current) workerRef.current.terminate();
    const worker = new Worker(new URL('../ingest/ingest.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    setBusy(true);
    worker.onmessage = (e: MessageEvent<IngestEvent | { type: 'locked' | 'idle'; docId?: string }>) => {
      const ev = e.data;
      if (ev.type === 'progress') {
        setProgress({ done: ev.done, total: ev.total, skipped: ev.skipped });
      } else if (ev.type === 'page') {
        addLog(`page ${ev.pageNo}: ${ev.status}${ev.reason ? ` (${reasonLabel(ev.reason)})` : ''}`);
      } else if (ev.type === 'finished') {
        addLog(`finished: ${ev.status}, review pages ${ev.review}, chunks ${ev.chunks}`);
        setProgress(null);
      } else if (ev.type === 'locked') {
        addLog('locked: this document is being processed in another tab');
      } else if (ev.type === 'error') {
        addLog(`error: ${(ev as { message: string }).message}`);
      } else if (ev.type === 'idle') {
        setBusy(false);
        worker.terminate();
        workerRef.current = null;
      }
    };
    worker.postMessage(msg);
  }

  function startIngest(recheck: boolean) {
    if (!selected) return;
    addLog(recheck ? 'recheck started (decisions kept)' : 'ingest started');
    post({ type: 'ingest', docId: selected.id, recheck });
  }

  async function reviewImage(pageNo: number) {
    if (!selected?.pdf) return;
    if (!pdfRef.current || pdfRef.current.docId !== selected.id) {
      if (pdfRef.current) await closePdf(pdfRef.current.pdf);
      pdfRef.current = { docId: selected.id, pdf: await openPdf(await selected.pdf.arrayBuffer()) };
    }
    const canvas = canvasRef.current;
    if (canvas) await renderPageInto(pdfRef.current.pdf, pageNo, 110, canvas);
  }

  useEffect(() => {
    if (reviewPageNo !== null) reviewImage(reviewPageNo).catch((e) => addLog(`render failed: ${String(e)}`));
  }, [reviewPageNo, selectedId]);

  useEffect(() => {
    if (!selected || selected.status !== 'ready' || pages.length === 0 || busy) {
      setAnalysisCheck(null);
      return;
    }
    let cancelled = false;
    const pageTexts = pages.map((p) => ({ pageNo: p.pageNo, text: p.text }));
    const result = chunkDocumentWithConfidence(pageTexts, { targetTokens: 700, maxTokens: 1200, minTokens: 250 }, { inputLimit: 100_000 });
    if (!cancelled) setAnalysisCheck(result.check);
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.prepFingerprint, selected?.chunkMode, pages.length, busy]);

  const review = pages.filter((p) => !FINAL_PAGE_STATUSES.includes(p.status));
  const reviewPage = pages.find((p) => p.pageNo === reviewPageNo) ?? null;
  const check =
    chunks.length > 0
      ? checkChunks(chunks, pages.map((p) => ({ pageNo: p.pageNo, text: p.text })), DEFAULT_CHUNK_CONFIG, {
          mode: selected?.chunkMode ?? 'structure',
          modeReason: selected?.chunkModeReason ?? '',
          inputLimit: 100_000,
        })
      : null;

  async function decide(page: PageRecord, decision: 'accept' | 'correct' | 'blank' | 'unresolved', text?: string) {
    if (!db) return;
    const now = Date.now();
    const finalText = decision === 'blank' ? '' : decision === 'correct' ? (text ?? '') : page.text;
    await db.put('ocr_decisions', { docId: page.docId, pageNo: page.pageNo, decision, text: finalText, savedAt: now }, [page.docId, page.pageNo]);
    if (decision === 'unresolved') {
      await db.put('pages', { ...page, status: 'review', reason: 'unresolved', updatedAt: now }, [page.docId, page.pageNo]);
    } else {
      await db.put(
        'pages',
        { ...page, text: finalText, status: decision === 'blank' ? 'blank' : 'accepted', source: 'manual', reason: null, updatedAt: now },
        [page.docId, page.pageNo],
      );
    }
    addLog(`page ${page.pageNo}: decision ${decision} saved`);
    setCorrection('');
    setReviewPageNo(null);
    post({ type: 'ingest', docId: page.docId });
  }

  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif', maxWidth: 1200 }}>
      <PageNav current="ingest" />
      <h2>Ingestion</h2>

      <div>
        <input type="file" accept="application/pdf" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        {persisted !== null && <span> storage persistent: {String(persisted)}</span>}
        {storage && !storage.fits && (
          <div style={{ color: 'red' }}>
            Quota warning: this file needs about {MB(storage.neededBytes)} free, but only {MB(storage.free)} is available.
          </div>
        )}
      </div>

      <h3>Documents</h3>
      <select value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value || null)}>
        <option value="">-- select --</option>
        {docs.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} [{d.status}] {d.id.slice(0, 8)}
          </option>
        ))}
      </select>

      {selected && (
        <div style={{ marginTop: 8 }}>
          <div>
            Status: <b>{selected.status}</b> · pages {selected.pageCount} · chunks {selected.chunkCount} · prep{' '}
            <code>{selected.prepFingerprint?.slice(0, 16) ?? '-'}</code> · doc hash <code>{selected.hash.slice(0, 16)}</code>
          </div>
          <div>
            OCR language:{' '}
            <select value={selected.ocrLangs} disabled={busy} onChange={(e) => setLangs(e.target.value)}>
              {LANG_OPTIONS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>{' '}
            <button disabled={busy} onClick={() => startIngest(false)}>Start / resume</button>{' '}
            <button disabled={busy} onClick={() => startIngest(true)}>Recheck (keep decisions)</button>
          </div>
          {progress && (
            <div>
              Progress: {progress.done} / {progress.total} pages (skipped {progress.skipped} already saved)
              <progress value={progress.done} max={progress.total} style={{ marginLeft: 8 }} />
            </div>
          )}
          <div>
            Review needed: {review.length} page(s).{' '}
            {selected.status === 'ready' ? <b style={{ color: 'green' }}>READY</b> : <span>Not ready</span>}
            <button
              style={{ marginLeft: 12 }}
              onClick={() => {
                setDebugOpen((v) => !v);
                if (debugPageNo === null) setDebugPageNo(pages[0]?.pageNo ?? 1);
              }}
            >
              Debug: extracted text
            </button>
          </div>
        </div>
      )}

      {selected && pages.length > 0 && (
        <>
          <h3>Pages</h3>
          <table border={1} cellPadding={3}>
            <thead>
              <tr><th>page</th><th>status</th><th>source</th><th>reason</th><th>ocr</th><th>native chars</th><th>images</th><th>review</th></tr>
            </thead>
            <tbody>
              {pages.map((p) => (
                <tr key={p.pageNo}>
                  <td>{p.pageNo}</td>
                  <td>{p.status}</td>
                  <td>{p.source ?? ''}</td>
                  <td>{reasonLabel(p.reason) ?? ''}</td>
                  <td style={{ fontSize: 11 }}>
                    {p.dpi ? `${p.dpi}dpi` : ''}
                    {p.ocrPsm ? ` · PSM ${p.ocrPsm}` : ''}
                    {p.ocrConfidence != null ? ` · ${Math.round(p.ocrConfidence)}%` : ''}
                    {p.ocrWords != null ? ` · ${p.ocrWords}w` : ''}
                  </td>
                  <td>{p.nativeChars}</td>
                  <td>{p.imageCount}</td>
                  <td>
                    {!FINAL_PAGE_STATUSES.includes(p.status) && (
                      <button onClick={() => { setReviewPageNo(p.pageNo); setCorrection(p.text); }}>review</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {reviewPage && (
        <div style={{ marginTop: 12, border: '1px solid #999', padding: 8 }}>
          <h3>Review page {reviewPage.pageNo} ({reasonLabel(reviewPage.reason) ?? reviewPage.status})</h3>
          {(reviewPage.dpi || reviewPage.ocrWords != null) && (
            <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>
              OCR: {reviewPage.dpi ?? '-'} DPI
              {reviewPage.ocrPsm ? ` · PSM ${reviewPage.ocrPsm}` : ''}
              {reviewPage.ocrConfidence != null ? ` · ${Math.round(reviewPage.ocrConfidence)}% confidence` : ''}
              {reviewPage.ocrWords != null ? ` · ${reviewPage.ocrWords} words` : ''}
            </div>
          )}
          {reviewPage.reason === 'render_decode_failed' && (
            <div style={{ color: '#a00', marginBottom: 6 }}>
              The PDF page has images but the rendered canvas is almost blank. This usually means a pdf.js image
              decoder asset is missing. Check that <code>/wasm/</code> is served with the pdf.js wasm files.
            </div>
          )}
          <div style={{ display: 'flex', gap: 12 }}>
            <canvas ref={canvasRef} style={{ width: 420, border: '1px solid #ccc' }} />
            <div style={{ flex: 1 }}>
              <textarea rows={18} style={{ width: '100%' }} value={correction} onChange={(e) => setCorrection(e.target.value)} />
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => decide(reviewPage, 'accept')}>Accept</button>
                <button onClick={() => decide(reviewPage, 'correct', correction)}>Save correction</button>
                <button onClick={() => decide(reviewPage, 'blank')}>Confirm blank</button>
                <button onClick={() => decide(reviewPage, 'unresolved')}>Leave unresolved</button>
                <button
                  disabled={busy}
                  onClick={() => { post({ type: 'ocr', docId: reviewPage.docId, pageNo: reviewPage.pageNo }); addLog(`page ${reviewPage.pageNo}: OCR retry (200–400 DPI, PSM 3/4/6, gray/binary)`); }}
                >
                  Retry OCR (best of 200–400 DPI)
                </button>
                <button onClick={() => { setDebugPageNo(reviewPage.pageNo); setDebugOpen(true); }}>Show extracted text</button>
                <button onClick={() => setReviewPageNo(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {chunks.length > 0 && (
        <>
          <h3>Chunks ({chunks.length})</h3>
          <table border={1} cellPadding={3}>
            <thead>
              <tr><th>#</th><th>clauses</th><th>pages</th><th>tokens (est)</th><th>start</th><th>heading</th><th>section</th><th>split</th></tr>
            </thead>
            <tbody>
              {chunks.map((c) => (
                <tr key={c.id}>
                  <td>{c.index}</td>
                  <td>{(c.clauses ?? []).join(', ') || c.clauseFrom || '-'}</td>
                  <td>{c.pageStart}-{c.pageEnd}</td>
                  <td>{c.tokenEst}</td>
                  <td>{c.startKind}</td>
                  <td>{c.heading ?? ''}</td>
                  <td>{c.parentSection ?? ''}</td>
                  <td>{c.split ? `part ${(c.partIndex ?? 0) + 1}/${c.partCount}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {check && (
        <>
          <h3>Chunk check</h3>
          <div style={{ fontFamily: 'monospace', fontSize: 13 }}>
            <div style={{ color: check.ok ? 'green' : 'red', fontWeight: 'bold' }}>
              {check.ok ? 'PASS' : 'FAIL'} · mode {check.mode}
              {check.modeReason ? ` (${check.modeReason})` : ''}
            </div>
            <div>
              chunks {check.chunkCount} · longest {check.longestChunkTokens} tokens · pages covered {check.coveredPages}/{check.pageCount} ·
              gaps {check.counts.gaps} · overlaps {check.counts.overlaps} · above max {check.counts.aboveMax} · above model input{' '}
              {check.counts.aboveInputLimit} · bad starts {check.counts.badStarts} · missing clauses {check.counts.missing} ·
              repeated clauses {check.counts.repeated} · split clauses {check.counts.split}
            </div>
            <div>
              section breaks {check.counts.sectionBreaks} · long clauses {check.counts.longClauses} · shared page ranges{' '}
              {check.counts.repeatedRanges}
            </div>
            {check.pageGaps.length > 0 && <div>gaps: pages {check.pageGaps.join(', ')}</div>}
            {check.pageOverlaps.length > 0 && <div>overlaps: pages {check.pageOverlaps.join(', ')}</div>}
            {check.badStarts.length > 0 && (
              <div>bad starts: {check.badStarts.map((b) => `#${b.index} (${b.reason})`).join('; ')}</div>
            )}
            {check.missingClauses.length > 0 && <div>missing: {check.missingClauses.join(', ')}</div>}
            {check.repeatedClauses.length > 0 && <div>repeated: {check.repeatedClauses.join(', ')}</div>}
            {check.splitClauses.length > 0 && (
              <div>split by size only: {check.splitClauses.map((s) => `${s.clause} in chunks ${s.chunkIndexes.join('/')}`).join('; ')}</div>
            )}
            {check.aboveMax.length > 0 && (
              <div>above max: {check.aboveMax.map((a) => `#${a.index} ${a.tokenEst}`).join('; ')}</div>
            )}
            {check.aboveInputLimit.length > 0 && (
              <div>above model input: {check.aboveInputLimit.map((a) => `#${a.index} ${a.tokenEst} > ${a.limit}`).join('; ')}</div>
            )}
            {check.longClauses.length > 0 && (
              <div>
                clauses over {DEFAULT_CHUNK_CONFIG.maxClausePages} pages:{' '}
                {check.longClauses.map((l) => `${l.clause} pages ${l.pageStart}-${l.pageEnd} (${l.pages}p, ${l.tokenEst} tok)`).join('; ')}
              </div>
            )}
            {check.repeatedRanges.length > 0 && (
              <div style={{ color: '#a00' }}>
                shared page ranges:{' '}
                {check.repeatedRanges.map((r) => `${r.pageStart}-${r.pageEnd} ×${r.count} (chunks ${r.chunkIndexes.slice(0, 8).join('/')}${r.chunkIndexes.length > 8 ? '…' : ''})`).join('; ')}
              </div>
            )}
            {check.sectionBreaks.length > 0 && (
              <div>section breaks: {check.sectionBreaks.map((s) => `p${s.page} ${s.label}`).join('; ')}</div>
            )}
          </div>

          {analysisCheck && (
            <>
              <h3>Analysis chunk check</h3>
              <div style={{ fontFamily: 'monospace', fontSize: 13 }}>
                <div style={{ color: analysisCheck.ok ? 'green' : 'red', fontWeight: 'bold' }}>
                  {analysisCheck.ok ? 'PASS' : 'FAIL'} · mode {analysisCheck.mode}
                  {analysisCheck.modeReason ? ` (${analysisCheck.modeReason})` : ''}
                </div>
                <div>
                  chunks {analysisCheck.chunkCount} · longest {analysisCheck.longestChunkTokens} tokens · above model input{' '}
                  {analysisCheck.counts.aboveInputLimit} · long clauses {analysisCheck.counts.longClauses} · shared page ranges{' '}
                  {analysisCheck.counts.repeatedRanges} · section breaks {analysisCheck.counts.sectionBreaks}
                </div>
                {analysisCheck.repeatedRanges.length > 0 && (
                  <div style={{ color: '#a00' }}>
                    shared page ranges:{' '}
                    {analysisCheck.repeatedRanges.map((r) => `${r.pageStart}-${r.pageEnd} ×${r.count}`).join('; ')}
                  </div>
                )}
                {analysisCheck.longClauses.length > 0 && (
                  <div>
                    long clauses: {analysisCheck.longClauses.map((l) => `${l.clause} ${l.pages}p`).join('; ')}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {debugOpen && (
        <aside
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            width: 520,
            background: '#fff',
            borderLeft: '1px solid #999',
            boxShadow: '-4px 0 12px rgba(0,0,0,0.15)',
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            fontFamily: 'sans-serif',
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid #ddd', display: 'flex', alignItems: 'center', gap: 8 }}>
            <b>Extracted text (debug)</b>
            <span style={{ fontSize: 11, color: '#666' }}>{pages.length} pages</span>
            <button style={{ marginLeft: 'auto' }} onClick={() => setDebugOpen(false)}>Close</button>
          </div>
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <div style={{ width: 170, overflow: 'auto', borderRight: '1px solid #eee' }}>
              {pages.map((p) => (
                <button
                  key={p.pageNo}
                  onClick={() => setDebugPageNo(p.pageNo)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '4px 6px',
                    border: 0,
                    borderBottom: '1px solid #f0f0f0',
                    background: p.pageNo === debugPageNo ? '#e8f0fe' : 'transparent',
                    color: p.status === 'review' ? '#a00' : '#222',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  p{p.pageNo} · {p.status} · {p.text.length}c
                  {p.reason ? ` · ${p.reason}` : ''}
                </button>
              ))}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
              {(() => {
                const p = pages.find((x) => x.pageNo === debugPageNo);
                if (!p) return <div style={{ fontSize: 12 }}>Select a page.</div>;
                return (
                  <>
                    <div style={{ fontSize: 11, color: '#555', marginBottom: 6 }}>
                      page {p.pageNo} · status {p.status} · source {p.source ?? '-'} · reason {reasonLabel(p.reason) ?? '-'} · dpi{' '}
                      {p.dpi ?? '-'} · psm {p.ocrPsm ?? '-'} · confidence {p.ocrConfidence != null ? Math.round(p.ocrConfidence) : '-'} · words{' '}
                      {p.ocrWords ?? '-'} · native chars {p.nativeChars} · text chars {p.text.length}
                    </div>
                    <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.35 }}>
                      {p.text.trim() ? p.text : '(no text)'}
                    </pre>
                  </>
                );
              })()}
            </div>
          </div>
        </aside>
      )}

      <h3>Log</h3>
      <pre style={{ maxHeight: 240, overflow: 'auto' }}>{log.join('\n')}</pre>
    </div>
  );
}
