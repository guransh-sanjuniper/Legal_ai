import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { openHarnessDb, type DocumentRecord, type HarnessDBHandle, type OcrDecision, type PageRecord } from '../../runner/db';
import { closePdf, openPdf, renderPageInto, type PdfDoc } from '../../ingest/pdfPages';
import { saveReviewDecision, waiveUnresolvedPages, type ReviewDecision } from '../../ingest/review';
import { getActiveDocId, runPreparation } from './prepare';
import { libraryStatus, readyLabel, statusLabel, statusTone } from './docStatus';
import { allPagesResolved, needsDecision, reviewDecisionFor } from './reviewPageLogic';
import { EmptyCard, PageHeader } from '../app/pages/Placeholder';
import { useDeveloperMode } from '../devMode';

const DECISION_TEXT: Record<ReviewDecision, string> = {
  accept: 'OCR text accepted',
  correct: 'Correction',
  blank: 'Blank page',
  unresolved: 'Left unresolved',
};

// A page needs a person when the pipeline could not decide it, or when it was proceeded
// without review. Pages a person already decided are shown for reference.

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
  const navigate = useNavigate();
  const [devOn] = useDeveloperMode();
  const [db, setDb] = useState<HarnessDBHandle | null>(null);
  const [doc, setDoc] = useState<DocumentRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pages, setPages] = useState<PageRecord[]>([]);
  const [decisions, setDecisions] = useState<Map<number, OcrDecision>>(new Map());
  const [running, setRunning] = useState(false);
  const [currentNo, setCurrentNo] = useState<number | null>(null);
  const [correction, setCorrection] = useState('');
  const [saving, setSaving] = useState(false);
  const [pdfReady, setPdfReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfRef = useRef<PdfDoc | null>(null);
  const decidingRef = useRef(false);
  const returningRef = useRef(false);

  useEffect(() => {
    openHarnessDb().then(setDb).catch((e) => setError(`Could not open local storage: ${String(e)}`));
  }, []);

  const load = useCallback(async () => {
    if (!db) return null;
    const record = await db.get('documents', docId);
    setDoc(record ?? null);
    setLoaded(true);
    const range = IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]);
    const freshPages = (await db.getAll('pages', range)).sort((a, b) => a.pageNo - b.pageNo);
    setPages(freshPages);
    const decided = await db.getAll('ocr_decisions', range);
    setDecisions(new Map(decided.map((d) => [d.pageNo, d])));
    setRunning(getActiveDocId() === docId);
    return freshPages;
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

  const list = pages.filter((p) => needsDecision(p) || decisions.has(p.pageNo));
  const pending = list.filter(needsDecision);
  const page = list.find((p) => p.pageNo === currentNo) ?? pending[0] ?? list[0] ?? null;
  const pageNo = page?.pageNo ?? null;
  const index = page ? list.findIndex((p) => p.pageNo === page.pageNo) : -1;
  const waivedCount = pages.filter((p) => p.source === 'waived').length;
  const blocked = !db || running || saving;

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
  // Resolves true once the run has started (its first non-failed state), false when it
  // could not start. It does not wait for the whole preparation.
  function continuePreparation(): Promise<boolean> {
    if (!db) return Promise.resolve(false);
    setError(null);
    setRunning(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (started: boolean) => {
        if (settled) return;
        settled = true;
        resolve(started);
      };
      void runPreparation(docId, {
        db,
        forceIngest: true,
        onEvent: (state) => {
          if (!state.failed) finish(true);
        },
      })
        .then(() => finish(true))
        .catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
          finish(false);
        })
        .finally(() => {
          setRunning(getActiveDocId() === docId);
          void load();
        });
    });
  }

  async function decide(target: PageRecord, decision: ReviewDecision, text?: string) {
    if (!db || decidingRef.current || returningRef.current) return;
    decidingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await saveReviewDecision(db, target, decision, text);
      // Read the stored pages after the write: the last-page check is then the same
      // whichever order the reviewer chose.
      const freshPages = await load();
      if (freshPages && freshPages.length > 0 && allPagesResolved(freshPages)) {
        const started = await continuePreparation();
        if (!started) return;
        returningRef.current = true;
        navigate('/documents');
        return;
      }
      const nextNo = pending.find((p) => p.pageNo > target.pageNo)?.pageNo ?? null;
      setCurrentNo(nextNo ?? target.pageNo);
      setNotice(`Page ${target.pageNo}: ${DECISION_TEXT[decision]} saved.`);
      void continuePreparation();
    } catch (e) {
      setError(`Could not save the decision: ${String(e)}`);
    } finally {
      decidingRef.current = false;
      setSaving(false);
    }
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
    void continuePreparation();
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
        description="Check the page image against the text. Accept the text, save a correction, or leave the page blank. Preparation continues when every page is done."
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
              {devOn && (
                <div className="app-muted">
                  {page.reason ? `${reasonLabel(page.reason)} · ` : ''}
                  {page.dpi ? `OCR ${page.dpi} DPI` : 'no OCR'}
                  {page.ocrPsm ? ` · PSM ${page.ocrPsm}` : ''}
                  {page.ocrConfidence != null ? ` · ${Math.round(page.ocrConfidence)}% confidence` : ''}
                  {page.ocrWords != null ? ` · ${page.ocrWords} words` : ''}
                </div>
              )}
              {page.reason === 'render_decode_failed' && (
                <div className="app-banner app-banner--error">
                  {devOn ? (
                    <>
                      The PDF page has images but the rendered canvas is almost blank. Check that <code>/wasm/</code> is served with the
                      pdf.js wasm files.
                    </>
                  ) : (
                    <>This page did not render, so the image may look blank. You can proceed without reviewing.</>
                  )}
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
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() => void decide(page, reviewDecisionFor('accept', correction))}
                  >
                    Accept text
                  </button>
                  <button type="button" disabled={blocked} onClick={() => void decide(page, 'correct', correction)}>
                    Save corrected text
                  </button>
                  <button type="button" disabled={blocked} onClick={() => void decide(page, 'blank')}>
                    Leave blank
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
