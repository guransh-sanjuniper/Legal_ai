import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { openHarnessDb, type DocumentRecord, type HarnessDBHandle, type OcrDecision, type PageRecord } from '../../runner/db';
import { closePdf, openPdf, renderPageInto, type PdfDoc } from '../../ingest/pdfPages';
import { saveReviewDecision, waiveUnresolvedPages, type ReviewDecision } from '../../ingest/review';
import { startPageOcr } from './ingestRunner';
import { getActiveDocId, runPreparation } from './prepare';
import { libraryStatus, readyLabel, statusLabel, statusTone } from './docStatus';
import { EmptyCard, PageHeader } from '../app/pages/Placeholder';

const DECISION_TEXT: Record<ReviewDecision, string> = {
  accept: 'OCR text accepted',
  correct: 'Correction',
  blank: 'Blank page',
  unresolved: 'Left unresolved',
};

// A page needs a person when the pipeline could not decide it, or when it was proceeded
// without review. Pages a person already decided are shown for reference.
const isPending = (p: PageRecord) => p.status === 'review' || p.source === 'waived';

function pageState(p: PageRecord): string {
  if (p.source === 'waived') return 'not reviewed';
  if (p.status === 'review') return 'needs decision';
  return 'resolved';
}

const reasonLabel = (reason: string | null) =>
  reason === 'render_decode_failed'
    ? 'images present but render is blank — check pdf.js wasm assets'
    : reason;

export function ReviewPage() {
  const { docId = '' } = useParams();
  const [db, setDb] = useState<HarnessDBHandle | null>(null);
  const [doc, setDoc] = useState<DocumentRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pages, setPages] = useState<PageRecord[]>([]);
  const [decisions, setDecisions] = useState<Map<number, OcrDecision>>(new Map());
  const [running, setRunning] = useState(false);
  const [currentNo, setCurrentNo] = useState<number | null>(null);
  const [correction, setCorrection] = useState('');
  const [saving, setSaving] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [pdfReady, setPdfReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfRef = useRef<PdfDoc | null>(null);

  useEffect(() => {
    openHarnessDb().then(setDb).catch((e) => setError(`Could not open local storage: ${String(e)}`));
  }, []);

  const load = useCallback(async () => {
    if (!db) return;
    const record = await db.get('documents', docId);
    setDoc(record ?? null);
    setLoaded(true);
    const range = IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]);
    setPages((await db.getAll('pages', range)).sort((a, b) => a.pageNo - b.pageNo));
    const decided = await db.getAll('ocr_decisions', range);
    setDecisions(new Map(decided.map((d) => [d.pageNo, d])));
    setRunning(getActiveDocId() === docId);
  }, [db, docId]);

  // Polled like the harness page: the preparation runs outside this component.
  useEffect(() => {
    if (!db) return;
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [db, load]);

  useEffect(() => {
    if (!db || !docId) return;
    let cancelled = false;
    let opened: PdfDoc | null = null;
    void (async () => {
      const record = await db.get('documents', docId);
      if (!record?.pdf || cancelled) return;
      opened = await openPdf(await record.pdf.arrayBuffer());
      if (cancelled) {
        await closePdf(opened);
        return;
      }
      pdfRef.current = opened;
      setPdfReady(true);
    })().catch((e) => setError(`Could not open the PDF: ${String(e)}`));
    return () => {
      cancelled = true;
      setPdfReady(false);
      pdfRef.current = null;
      if (opened) void closePdf(opened);
    };
  }, [db, docId]);

  const list = pages.filter((p) => isPending(p) || decisions.has(p.pageNo));
  const pending = list.filter(isPending);
  const page = list.find((p) => p.pageNo === currentNo) ?? pending[0] ?? list[0] ?? null;
  const pageNo = page?.pageNo ?? null;
  const index = page ? list.findIndex((p) => p.pageNo === page.pageNo) : -1;
  const waivedCount = pages.filter((p) => p.source === 'waived').length;
  const blocked = !db || running || saving || ocrBusy;

  useEffect(() => {
    if (!pdfReady || pageNo === null || !canvasRef.current || !pdfRef.current) return;
    renderPageInto(pdfRef.current, pageNo, 110, canvasRef.current).catch((e) => setError(`Render failed: ${String(e)}`));
  }, [pdfReady, pageNo]);

  // Each page starts from its OCR text; the textarea is not reset by the polling refresh.
  useEffect(() => {
    setCorrection(page?.text ?? '');
  }, [pageNo]);

  // Ingestion and the rest of preparation continue from the saved decisions. The
  // library runner is the only orchestrator; this screen only asks it to continue.
  function continuePreparation(recheck = false) {
    if (!db) return;
    setError(null);
    setRunning(true);
    void runPreparation(docId, { db, forceIngest: true, recheck })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setRunning(getActiveDocId() === docId);
        void load();
      });
  }

  async function decide(target: PageRecord, decision: ReviewDecision, text?: string) {
    if (!db) return;
    setSaving(true);
    setError(null);
    try {
      await saveReviewDecision(db, target, decision, text);
      const nextNo = pending.find((p) => p.pageNo > target.pageNo)?.pageNo ?? null;
      setCurrentNo(nextNo ?? target.pageNo);
      setNotice(`Page ${target.pageNo}: ${DECISION_TEXT[decision]} saved.`);
      await load();
      continuePreparation();
    } catch (e) {
      setError(`Could not save the decision: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function retryOcr(target: PageRecord) {
    if (!db) return;
    setError(null);
    setOcrBusy(true);
    startPageOcr(docId, target.pageNo, (event) => {
      if (event.type === 'locked') {
        setError('This document is being processed in another tab.');
        setOcrBusy(false);
      } else if (event.type === 'error') {
        setError(event.message);
        setOcrBusy(false);
      } else if (event.type === 'idle') {
        setOcrBusy(false);
        setNotice(`Page ${target.pageNo}: OCR retried.`);
        void load().then(() => continuePreparation());
      }
    });
  }

  async function proceedWithoutReview() {
    if (!db || !doc) return;
    const confirmed = window.confirm(
      `Proceed without reviewing "${doc.name}"?\n\n${pending.length} page(s) need a decision. ` +
        'OCR text will be used as extracted; unreviewed pages may contain errors.',
    );
    if (!confirmed) return;
    setError(null);
    const waived = await waiveUnresolvedPages(db, doc.id);
    setNotice(`${waived} page(s) proceed with their OCR text as extracted.`);
    await load();
    continuePreparation();
  }

  if (!loaded) return <p className="app-muted">Loading review…</p>;

  if (!doc) {
    return (
      <EmptyCard title="Document not found">
        <p>This document is not on this device.</p>
        <Link className="app-primary-button" to="/documents">
          Back to Documents
        </Link>
      </EmptyCard>
    );
  }

  const statusText =
    doc.status === 'ready' ? readyLabel(waivedCount) : statusLabel(libraryStatus(doc.status), pending.length);
  const tone = statusTone(libraryStatus(doc.status));
  const resolved = list.length - pending.length;

  return (
    <>
      <PageHeader
        eyebrow="Review"
        title={doc.name}
        description="Compare each page image with its OCR text. Each decision is saved at once; preparation continues when the last page is resolved."
        actions={
          <Link className="app-link-button" to="/documents">
            Back to Documents
          </Link>
        }
      />

      <div className="app-review-status">
        <span className={`app-chip app-chip--${tone}`}>{statusText}</span>
        <span>
          {resolved} of {list.length} resolved
        </span>
        {running && <span className="app-stage-label">Preparation is running. Decisions are available when it finishes.</span>}
      </div>

      {notice && <div className="app-banner app-banner--notice">{notice}</div>}
      {error && (
        <div className="app-banner app-banner--error" role="alert">
          {error}
        </div>
      )}

      {list.length === 0 || !page ? (
        <EmptyCard title="Nothing to review">
          <p>No page needs a decision. Every page was accepted automatically.</p>
        </EmptyCard>
      ) : (
        <div className="app-review-layout">
          <nav className="app-review-pages" aria-label="Pages to review">
            {list.map((p) => (
              <button
                key={p.pageNo}
                type="button"
                className={`app-review-page${p.pageNo === page.pageNo ? ' app-review-page--active' : ''}`}
                onClick={() => setCurrentNo(p.pageNo)}
              >
                <span>Page {p.pageNo}</span>
                <span className="app-muted">{pageState(p)}</span>
              </button>
            ))}
          </nav>

          <section className="app-review-main">
            <div className="app-review-heading">
              <h2>
                Page {page.pageNo} · {pageState(page)}
              </h2>
              <div className="app-muted">
                {page.reason ? `${reasonLabel(page.reason)} · ` : ''}
                {page.dpi ? `OCR ${page.dpi} DPI` : 'no OCR'}
                {page.ocrPsm ? ` · PSM ${page.ocrPsm}` : ''}
                {page.ocrConfidence != null ? ` · ${Math.round(page.ocrConfidence)}% confidence` : ''}
                {page.ocrWords != null ? ` · ${page.ocrWords} words` : ''}
              </div>
              {page.reason === 'render_decode_failed' && (
                <div className="app-banner app-banner--error">
                  The PDF page has images but the rendered canvas is almost blank. Check that <code>/wasm/</code> is served with the
                  pdf.js wasm files.
                </div>
              )}
            </div>

            <div className="app-review-compare">
              <canvas ref={canvasRef} className="app-review-image" />
              <div className="app-review-text">
                <textarea
                  rows={18}
                  value={correction}
                  onChange={(e) => setCorrection(e.target.value)}
                  aria-label={`OCR text for page ${page.pageNo}`}
                />
                <div className="app-review-actions">
                  <button type="button" className="app-primary-button" disabled={blocked} onClick={() => void decide(page, 'accept')}>
                    Accept OCR text
                  </button>
                  <button type="button" disabled={blocked} onClick={() => void decide(page, 'correct', correction)}>
                    Save correction
                  </button>
                  <button type="button" disabled={blocked} onClick={() => void decide(page, 'blank')}>
                    Confirm blank
                  </button>
                  <button type="button" disabled={blocked} onClick={() => void decide(page, 'unresolved')}>
                    Leave unresolved
                  </button>
                  <button type="button" disabled={blocked} onClick={() => retryOcr(page)}>
                    Retry OCR
                  </button>
                </div>
              </div>
            </div>

            <div className="app-review-footer">
              <button type="button" disabled={index <= 0} onClick={() => setCurrentNo(list[index - 1].pageNo)}>
                Previous
              </button>
              <button type="button" disabled={index >= list.length - 1} onClick={() => setCurrentNo(list[index + 1].pageNo)}>
                Next
              </button>
              <button type="button" disabled={blocked} onClick={() => continuePreparation(true)}>
                Recheck (keeps decisions)
              </button>
              {pending.length > 0 && (
                <button type="button" className="app-link-button app-link-button--danger" disabled={blocked} onClick={() => void proceedWithoutReview()}>
                  Proceed without reviewing
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
