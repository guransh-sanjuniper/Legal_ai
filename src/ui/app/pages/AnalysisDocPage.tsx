import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { openHarnessDb, rawKey, type DocumentRecord, type HarnessDBHandle } from '../../../runner/db';
import { libraryStatusFrom, stageLabel, statusLabel, statusTone } from '../../library/docStatus';
import { isPrepared, readPreparationState, type PreparationState } from '../../library/preparationState';
import { EmptyCard, PageHeader } from './Placeholder';
import { useAuth } from '../AuthProvider';
import { RetrievalClient } from '../../../retrieval/client';
import { getDefinitions, definitionsContext } from '../../../retrieval/definitions';
import { buildAnalysisChunks, type AnalysisChunk } from '../../../analysis/analysisChunks';
import { loadPageMap, restoreReportFromSupabase, runAnalysis, RateLimitedPause, taskChunkIndex } from '../../../analysis/runAnalysis';
import { ANALYSIS_MODEL, FALLBACK_MODEL, INITIAL_MAX_TOKENS } from '../../../analysis/config';
import { buildClausePrompt } from '../../../analysis/prompts';
import type { DocType } from '../../../analysis/docType';
import { normaliseRequest } from '../../../analysis/request';
import { estimateRun, type RunEstimate } from '../../../analysis/costEstimate';
import { computeMetrics } from '../../../analysis/execute';
import { buildReportModel, type Citation, type ReportModel } from '../../../analysis/reportModel';
import type { AnalysisMetrics, AnalysisReport } from '../../../analysis/types';
import { supabase } from '../../../lib/supabase';
import { StartForm, type StartFormValues } from '../../analysis/StartForm';
import { RunPanel, type FailedRow, type RunProgress } from '../../analysis/RunPanel';
import { ReportView } from '../../analysis/ReportView';
import { useDeveloperMode } from '../../devMode';
import { KeepTabOpen } from '../../KeepTabOpen';
import { useLeaveGuard } from '../../useLeaveGuard';
import { CitationPanel } from '../../analysis/CitationPanel';
import { ExportBar } from '../../analysis/ExportBar';
import { freshToken, functionsEndpoint, readRunRecord, withDocumentLock, writeRunRecord, taskLabel, type RunRecord } from '../../analysis/runtime';
import { StartNotice } from '../../analysis/StartNotice';
import { readHideStartNotice } from '../../analysis/startNotice';
import { reportScrollBehavior, reportScrollTop, shouldScrollToReport } from '../../analysis/reportScroll';
import '../../analysis/analysis.css';

interface Plan {
  chunks: AnalysisChunk[];
  defsContext: string;
  docType: DocType | null;
  clauseCount: number;
  budget: number;
}

const DEFAULT_FORM: StartFormValues = { matter: '', detailLevel: 'standard', reviewingFor: 'neutral', focus: '', customPrompt: '' };
// Stored section summaries are estimated at this many characters per clause (upper bound).
const SUMMARY_CHARS_PER_CLAUSE = 300;

export function AnalysisDocPage() {
  const { docId } = useParams<{ docId: string }>();
  const auth = useAuth();
  const [devOn] = useDeveloperMode();
  const session = auth.session;

  const [db, setDb] = useState<HarnessDBHandle | null>(null);
  const [doc, setDoc] = useState<DocumentRecord | null | undefined>(undefined);
  const [prepared, setPrepared] = useState(false);
  const [prepState, setPrepState] = useState<PreparationState | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [form, setForm] = useState<StartFormValues>(DEFAULT_FORM);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [model, setModel] = useState<ReportModel | null>(null);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [metrics, setMetrics] = useState<AnalysisMetrics | null>(null);
  const [failedRows, setFailedRows] = useState<FailedRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const [startNoticeOpen, setStartNoticeOpen] = useState(false);

  const leaveGuard = useLeaveGuard({ active: running, job: 'analysis' });

  const retrieval = useRef<RetrievalClient | null>(null);
  const planRef = useRef<Plan | null>(null);
  planRef.current = plan;
  const reportRef = useRef<HTMLDivElement | null>(null);
  // True only when a run started on this page has just produced a report. Loading or
  // restoring a saved report never sets it, so those never scroll.
  const finishedThisVisitRef = useRef(false);

  // A run finished in this visit: wait one frame for layout to settle, then scroll the
  // export bar and report into view once. The ref wraps both, so the Export buttons are
  // fully visible above the report title. Only content whose top is still below the
  // viewport moves.
  useEffect(() => {
    if (running || !model || !finishedThisVisitRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (!finishedThisVisitRef.current) return;
      finishedThisVisitRef.current = false;
      const element = reportRef.current;
      const reportTop = element ? element.getBoundingClientRect().top : null;
      if (!element || reportTop === null) return;
      if (!shouldScrollToReport({ finishedThisVisit: true, reportShown: Boolean(model), reportTop })) return;
      window.scrollTo({
        top: reportScrollTop(reportTop, window.scrollY),
        behavior: reportScrollBehavior(window.matchMedia('(prefers-reduced-motion: reduce)').matches),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [running, model]);

  // A different document, or leaving the page, drops any pending scroll attempt.
  useEffect(() => () => {
    finishedThisVisitRef.current = false;
  }, [docId]);

  useEffect(() => {
    const client = new RetrievalClient();
    retrieval.current = client;
    return () => client.dispose();
  }, []);

  useEffect(() => {
    openHarnessDb().then(setDb).catch(() => setDoc(null));
  }, []);

  useEffect(() => {
    if (!db || !docId) return;
    let alive = true;
    (async () => {
      const found = (await db.get('documents', docId)) as DocumentRecord | undefined;
      if (!alive) return;
      setDoc(found ?? null);
      if (!found) return;
      setPrepared(await isPrepared(db, found));
      setPrepState(readPreparationState(found.id));
      setRecord(readRunRecord(found.id));

      const local = (await db.getAllFromIndex('analysis_reports', 'byDoc', docId)) as { report: unknown; savedAt: number }[];
      let loaded: AnalysisReport | null = null;
      if (local.length) {
        loaded = [...local].sort((a, b) => b.savedAt - a.savedAt)[0].report as AnalysisReport;
      } else if (supabase) {
        loaded = await restoreReportFromSupabase(supabase, docId);
      }
      if (!alive) return;
      if (loaded) {
        setReport(loaded);
        setModel(buildReportModel(loaded));
      }

      const pages = await loadPageMap(db, docId);
      const chunks = buildAnalysisChunks(pages);
      const sheet = await getDefinitions(db, docId);
      const st = await db.get('analysis_state', docId);
      if (!alive) return;
      setPlan({
        chunks,
        defsContext: sheet ? definitionsContext(sheet) : '',
        docType: found.docType ?? null,
        clauseCount: chunks.reduce((n, c) => n + c.manifest.length, 0),
        budget: st?.maxTokens ?? INITIAL_MAX_TOKENS,
      });
    })().catch((e) => setError(String(e)));
    return () => {
      alive = false;
    };
  }, [db, docId]);

  const estimate: RunEstimate | null = useMemo(() => {
    if (!plan) return null;
    return estimateRun({
      clausePrompt: buildClausePrompt({ docType: plan.docType, detail: form.detailLevel, focus: form.focus, reviewingFor: form.reviewingFor }),
      defsContext: plan.defsContext,
      chunkTexts: plan.chunks.map((c) => c.pageMarkedText),
      clauseCount: plan.clauseCount,
      summaryChars: plan.clauseCount * SUMMARY_CHARS_PER_CLAUSE,
      budget: plan.budget,
      detail: form.detailLevel,
      focus: form.focus,
      customPrompt: form.customPrompt,
    });
  }, [plan, form]);

  // The run the page is showing: the one being worked on, else the report's run.
  const runId = record?.runId ?? report?.runId ?? null;

  async function refreshRunInfo(id: string | null) {
    if (!db || !id) {
      setMetrics(null);
      setFailedRows([]);
      return;
    }
    const tasks = await db.getAllFromIndex('tasks', 'byRun', id);
    setMetrics(await computeMetrics(db, tasks));
    const rows: FailedRow[] = [];
    for (const t of tasks) {
      if (t.status !== 'failed') continue;
      const kind = /^[a-z]+/.exec(t.id.slice(t.id.lastIndexOf(':') + 1))?.[0] ?? '';
      const chunk = ['a', 'r', 'x', 'c', 'cx'].includes(kind)
        ? planRef.current?.chunks.find((c) => c.index === taskChunkIndex(t.id))
        : undefined;
      let snippet: string | undefined;
      if (t.attemptId) {
        const raw = await db.get('raw_responses', rawKey(t.id, t.attemptId));
        if (raw?.text) snippet = raw.text.replace(/\s+/g, ' ').slice(0, 300);
      }
      rows.push({
        id: t.id,
        label: taskLabel(t.id),
        pages: chunk ? `pages ${chunk.pageStart}–${chunk.pageEnd}` : '—',
        code: t.failureCode ?? 'unknown',
        message: t.failureMessage ?? '',
        attempts: t.attemptNo,
        snippet,
      });
    }
    setFailedRows(rows);
  }

  useEffect(() => {
    if (!db || !runId) return;
    void refreshRunInfo(runId);
    // Re-read the run's counts while a run is active.
    if (!running) return;
    const timer = window.setInterval(async () => {
      const tasks = await db.getAllFromIndex('tasks', 'byRun', runId);
      const leaves = tasks.filter((t) => t.status !== 'split');
      setProgress({
        total: leaves.length,
        done: leaves.filter((t) => t.status === 'done').length,
        failed: leaves.filter((t) => t.status === 'failed').length,
        active: leaves.filter((t) => ['queued', 'requesting', 'received', 'retry_wait', 'uncertain'].includes(t.status)).length,
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [db, runId, running]);

  const canResume = Boolean(record) && !running && (!report || report.runId !== record?.runId);
  const canRetry = Boolean(record) && !running && failedRows.length > 0 && report?.runId === record?.runId;

  // The start pop-up only gates the call to execute(); it changes nothing inside it.
  function requestStart() {
    if (readHideStartNotice()) {
      void execute('start');
      return;
    }
    setStartNoticeOpen(true);
  }

  async function execute(mode: 'start' | 'resume' | 'retry') {
    if (!db || !doc || !docId) return;
    if (!supabase || !session) {
      setError('Sign in to run an analysis.');
      return;
    }
    const current = mode === 'start' ? null : record;
    if (mode !== 'start' && !current) {
      setError('There is no run to resume.');
      return;
    }
    const request = current?.request ?? normaliseRequest({ ...form });
    let activeRunId: string | null = current?.runId ?? null;
    finishedThisVisitRef.current = false;
    setRunning(true);
    setError(null);
    setStatus(mode === 'start' ? 'Starting…' : 'Resuming…');
    try {
      const token = await freshToken();
      if (!token) throw new Error('Sign in again to run the analysis.');
      const lock = await withDocumentLock(doc, () =>
        runAnalysis({
          db,
          supabase: supabase!,
          accessToken: token,
          refreshAccessToken: freshToken,
          userId: session.user.id,
          ...functionsEndpoint(),
          docId,
          model: ANALYSIS_MODEL,
          fallbackModel: FALLBACK_MODEL,
          reasoning: { effort: 'minimal' },
          request,
          resumeRunId: current?.runId,
          retryFailed: mode === 'retry',
          lawSearch: async (text, k) => (await retrieval.current!.lawSearch(text, k)).results,
          docSearch: async (q, k) => {
            const r = await retrieval.current!.search(docId, q, k);
            if (!r || !Array.isArray(r.results)) throw new Error('search returned no result list');
            return r.results;
          },
          onRunCreated: (id) => {
            activeRunId = id;
            const next: RunRecord = { runId: id, request, startedAt: Date.now() };
            writeRunRecord(docId, next);
            setRecord(next);
          },
          onProgress: (m) => setStatus(m),
        }),
      );
      if (!lock.ran) {
        setError('This document is being prepared or analysed in another tab. Wait for it to finish, then try again.');
        return;
      }
      const saved = lock.value;
      setReport(saved);
      setModel(buildReportModel(saved));
      finishedThisVisitRef.current = true;
      const left = (await db.getAllFromIndex('tasks', 'byRun', saved.runId)).filter((t) => t.status === 'failed').length;
      if (left === 0) {
        writeRunRecord(docId, null);
        setRecord(null);
        setStatus('Report saved.');
      } else {
        setStatus(`Report saved with ${left} failed task(s). Use Retry failed only to re-run them.`);
      }
    } catch (e) {
      if (e instanceof RateLimitedPause) {
        setStatus(`Paused: rate limited. Resume in about ${Math.ceil(e.retryAfterMs / 1000)} s.`);
      } else {
        setError(String(e));
      }
    } finally {
      setRunning(false);
      setProgress(null);
      await refreshRunInfo(activeRunId);
    }
  }

  if (doc === undefined) {
    return (
      <>
        <PageHeader eyebrow="Module" title="Deep Analysis" />
        <p className="app-muted">Loading document…</p>
      </>
    );
  }

  if (doc === null) {
    return (
      <>
        <PageHeader eyebrow="Module" title="Deep Analysis" description="This document is not stored on this device." />
        <EmptyCard title="Document not on this device">
          <p>
            Import the PDF again on this device to run a new analysis. Reports already saved to Supabase stay available after the
            document is imported and matched by its hash.
          </p>
          <Link className="app-primary-button" to="/documents">
            Go to Documents
          </Link>
        </EmptyCard>
      </>
    );
  }

  const status0 = libraryStatusFrom({ doc, prepared, state: prepState, reviewPages: 0 });
  const label = statusLabel(status0, prepState?.review?.pages ?? 0, devOn ? prepState?.stage : null);
  // With Developer mode off the counters, metrics and failed-task table are hidden, so an idle
  // run card can be empty. Hide it rather than leave a blank card. On, it is always shown.
  const runPanelVisible =
    devOn || Boolean(running || error || status || progress || canResume || canRetry || failedRows.length > 0);

  return (
    <>
      <PageHeader
        eyebrow="Module"
        title={doc.name}
        description={`${doc.pageCount} pages${devOn ? ` · ${doc.chunkCount} chunks` : ''} · prepared on this device`}
        helpPageId={model ? 'analysis-report' : 'analysis-list'}
        actions={<span className={`app-chip app-chip--${statusTone(status0)}`}>{label}</span>}
      />

      {!prepared ? (
        <EmptyCard title="This document is not ready yet">
          <p>
            {prepState?.stage === 'failed'
              ? devOn
                ? `Preparation failed at ${stageLabel(prepState.failed?.stage ?? null)}: ${prepState.failed?.message ?? 'unknown error'}`
                : `Preparation failed: ${prepState.failed?.message ?? 'unknown error'}`
              : 'Finish preparation and page review first. Analysis never runs on pages that are still unresolved.'}
          </p>
          {devOn ? (
            <a className="app-primary-button" href={`/?page=ingest&doc=${encodeURIComponent(doc.id)}`}>
              Open preparation page
            </a>
          ) : (
            <Link className="app-primary-button" to="/documents">
              Go to Documents
            </Link>
          )}
        </EmptyCard>
      ) : (
        <>
          <div className="ana-layout">
            <section className="ana-card ana-card--static">
              <div className="ana-card-head ana-card-head--static">
                <span className="ana-card-title">Run analysis</span>
              </div>
              <div className="ana-card-body">
                <StartForm
                  values={form}
                  onChange={setForm}
                  estimate={estimate}
                  disabled={running || !plan}
                  onStart={requestStart}
                  startLabel={report ? 'Start a new analysis' : 'Start analysis'}
                />
              </div>
            </section>
            {runPanelVisible && (
              <section className="ana-card ana-card--static">
                <div className="ana-card-head ana-card-head--static">
                  <span className="ana-card-title">Progress and failures</span>
                </div>
                <div className="ana-card-body">
                  <RunPanel
                    running={running}
                    status={status}
                    error={error}
                    progress={progress}
                    metrics={metrics}
                    failedRows={failedRows}
                    canResume={canResume}
                    canRetry={canRetry}
                    onResume={() => execute('resume')}
                    onRetry={() => execute('retry')}
                  />
                  <KeepTabOpen prominent show={running} />
                </div>
              </section>
            )}
          </div>

          {model ? (
            <div ref={reportRef}>
              <ExportBar model={model} documentName={doc.name} />
              <ReportView model={model} onCite={setCitation} />
            </div>
          ) : (
            <p className="app-muted">No report yet. Start an analysis above.</p>
          )}
        </>
      )}

      <CitationPanel docId={doc.id} citation={citation} onClose={() => setCitation(null)} />
      {startNoticeOpen && (
        <StartNotice
          onStart={() => {
            setStartNoticeOpen(false);
            void execute('start');
          }}
          onClose={() => setStartNoticeOpen(false)}
        />
      )}
      <p className="app-back-link">
        <Link to="/documents">← Back to documents</Link>
      </p>
      {leaveGuard.dialog}
    </>
  );
}
