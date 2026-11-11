import { useEffect, useRef, useState } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import { openHarnessDb, type HarnessDBHandle, type AnalysisReportRecord, type DocumentRecord } from '../runner/db';
import type { Task } from '../tasks/types';
import { RetrievalClient, type SearchResult } from '../retrieval/client';
import { getDefinitions } from '../retrieval/definitions';
import { runAnalysis, restoreReportFromSupabase } from '../analysis/runAnalysis';
import { runJudgement, looksLikeDeveloperObligation, type JudgementResult } from '../analysis/judgement';
import { askRetrieval, type AskResult, type RetrievedChunk } from '../analysis/ask';
import { runFallbackCheck, runForcedFailure, type FallbackCheckResult } from '../analysis/fallbackCheck';
import { ANALYSIS_MODEL, FALLBACK_MODEL } from '../analysis/config';
import type { AnalysisReport } from '../analysis/types';
import { ledgerSummary } from '../analysis/ledger';
import { scorePayments, scoreDeveloperFavour } from '../analysis/goldenScore';
import paymentsGolden from '../../tests/golden/hiramoti_payments.json';
import developerGolden from '../../tests/golden/hiramoti_developer_favour.json';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const TEST_EMAIL = import.meta.env.VITE_TEST_EMAIL as string | undefined;
const TEST_PASSWORD = import.meta.env.VITE_TEST_PASSWORD as string | undefined;

const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const money = (n: number) => `$${n.toFixed(4)}`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

export function AnalysisPage() {
  const [db, setDb] = useState<HarnessDBHandle | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [docId, setDocId] = useState<string | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [source, setSource] = useState<'local' | 'supabase' | null>(null);
  const [progress, setProgress] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failedTasks, setFailedTasks] = useState<Task[]>([]);
  const [askMode, setAskMode] = useState<'retrieval' | 'whole'>('whole');
  const [askQuery, setAskQuery] = useState('Which clauses favour the Developer?');
  const [ask, setAsk] = useState<AskResult | null>(null);
  const [judgement, setJudgement] = useState<JudgementResult | null>(null);
  const [fb, setFb] = useState<FallbackCheckResult | null>(null);
  const [forced, setForced] = useState<{ pass: boolean; detail: string } | null>(null);
  const clientRef = useRef<RetrievalClient | null>(null);

  const addLog = (line: string) => setLog((l) => [...l.slice(-300), `${new Date().toLocaleTimeString()} ${line}`]);

  useEffect(() => {
    openHarnessDb().then(async (handle) => {
      setDb(handle);
      setDocs((await handle.getAll('documents')).filter((d) => d.status === 'ready').sort((a, b) => b.createdAt - a.createdAt));
    });
    sb.auth.getSession().then(async ({ data }) => {
      if (!data.session && TEST_EMAIL && TEST_PASSWORD) {
        const r = await sb.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
        setSession(r.data.session);
        return;
      }
      setSession(data.session);
    });
    clientRef.current = new RetrievalClient();
    return () => clientRef.current?.dispose();
  }, []);

  useEffect(() => {
    if (!db || !docId) {
      setReport(null);
      setSource(null);
      return;
    }
    (async () => {
      const local = (await db.getAllFromIndex('analysis_reports', 'byDoc', docId)) as AnalysisReportRecord[];
      if (local.length) {
        const latest = local.sort((a, b) => b.savedAt - a.savedAt)[0];
        setReport(latest.report as AnalysisReport);
        setSource('local');
        await loadFailed(latest.runId);
        return;
      }
      const remote = await restoreReportFromSupabase(sb, docId);
      if (remote) {
        setReport(remote);
        setSource('supabase');
        addLog('restored report from Supabase');
        await loadFailed(remote.runId);
      } else {
        setReport(null);
        setSource(null);
      }
    })();
  }, [db, docId]);

  async function loadFailed(runId: string) {
    if (!db) return;
    setFailedTasks((await db.getAllFromIndex('tasks', 'byRun', runId)).filter((t) => t.status === 'failed'));
  }

  function searchAdapter(): ((q: string, k: number) => Promise<RetrievedChunk[]>) | null {
    if (!clientRef.current || !docId) return null;
    return async (q, k) => {
      const r = await clientRef.current!.search(docId, q, k);
      if (!r || !Array.isArray(r.results)) throw new Error('search returned no result list');
      return r.results.map((x: SearchResult) => ({
        chunkId: x.chunkId,
        pageStart: x.pageStart,
        pageEnd: x.pageEnd,
        clauses: x.clauses,
        windowText: x.windowText,
        fused: x.fused,
        vectorScore: x.vectorScore,
        keywordScore: x.keywordScore,
      }));
    };
  }

  async function analyse() {
    if (!db || !docId || !session || !clientRef.current) return;
    setBusy(true);
    setProgress('starting');
    try {
      const r = await runAnalysis({
        db,
        supabase: sb,
        accessToken: session.access_token,
        userId: session.user.id,
        functionsUrl: `${SUPABASE_URL}/functions/v1`,
        anonKey: ANON_KEY,
        docId,
        model: ANALYSIS_MODEL,
        fallbackModel: FALLBACK_MODEL,
        reasoning: { effort: 'minimal' },
        lawSearch: async (text, k) => clientRef.current!.lawSearch(text, k).then((x) => x.results),
        docSearch: async (q, k) => {
          const r = await clientRef.current!.search(docId, q, k);
          if (!r || !Array.isArray(r.results)) throw new Error('search returned no result list');
          return r.results;
        },
        onProgress: (m) => setProgress(m),
        onLog: addLog,
      });
      setReport(r);
      setSource('local');
      setProgress('done');
      await loadFailed(r.runId);
    } catch (e) {
      addLog(`analysis failed: ${String(e)}`);
      setProgress(`error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runAskOrJudge() {
    if (!db || !docId || !session || !clientRef.current) return;
    setBusy(true);
    try {
      if (askMode === 'retrieval') {
        setAsk(
          await askRetrieval({
            db,
            supabase: sb,
            accessToken: session.access_token,
            userId: session.user.id,
            functionsUrl: `${SUPABASE_URL}/functions/v1`,
            anonKey: ANON_KEY,
            docId,
            query: askQuery,
            model: ANALYSIS_MODEL,
            fallbackModel: FALLBACK_MODEL,
            search: searchAdapter()!,
            onLog: addLog,
          }),
        );
        setJudgement(null);
      } else {
        const sheet = await getDefinitions(db, docId);
        const j = await runJudgement({
          db,
          supabase: sb,
          accessToken: session.access_token,
          userId: session.user.id,
          functionsUrl: `${SUPABASE_URL}/functions/v1`,
          anonKey: ANON_KEY,
          docId,
          question: askQuery,
          sheet,
          model: ANALYSIS_MODEL,
          fallbackModel: FALLBACK_MODEL,
          onLog: addLog,
        });
        setJudgement(j);
        setAsk(null);
        addLog(`judgement: ${j.summary}`);
      }
    } catch (e) {
      addLog(`ask failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function clearLocal() {
    if (!db || !docId) return;
    const records = (await db.getAllFromIndex('analysis_reports', 'byDoc', docId)) as AnalysisReportRecord[];
    const tx = db.transaction(['analysis_reports', 'analysis_state'], 'readwrite');
    for (const r of records) await tx.objectStore('analysis_reports').delete(r.runId);
    await tx.objectStore('analysis_state').delete(docId);
    await tx.done;
    setReport(null);
    setSource(null);
    setAsk(null);
    setJudgement(null);
    addLog('cleared local analysis state; use Restore to load from Supabase');
  }

  async function restore() {
    if (!docId) return;
    const remote = await restoreReportFromSupabase(sb, docId);
    if (remote) {
      setReport(remote);
      setSource('supabase');
      addLog('restored report from Supabase');
      await loadFailed(remote.runId);
    } else addLog('no report found in Supabase for this document');
  }

  async function checkFallback() {
    if (!db || !docId || !session) return;
    const doc = docs.find((d) => d.id === docId)!;
    setBusy(true);
    try {
      const r = await runFallbackCheck(
        { db, supabase: sb, accessToken: session.access_token, userId: session.user.id, functionsUrl: `${SUPABASE_URL}/functions/v1`, anonKey: ANON_KEY, model: ANALYSIS_MODEL, fallbackModel: FALLBACK_MODEL },
        doc,
      );
      setFb(r);
      addLog(`fallback check: ${r.pass ? 'PASS' : 'FAIL'} (${r.detail})`);
    } finally {
      setBusy(false);
    }
  }

  async function checkFailure() {
    if (!db || !docId || !session) return;
    const doc = docs.find((d) => d.id === docId)!;
    setBusy(true);
    try {
      const r = await runForcedFailure(
        { db, supabase: sb, accessToken: session.access_token, userId: session.user.id, functionsUrl: `${SUPABASE_URL}/functions/v1`, anonKey: ANON_KEY, model: ANALYSIS_MODEL, fallbackModel: FALLBACK_MODEL },
        doc,
      );
      setForced(r);
      addLog(`forced failure: ${r.pass ? 'PASS' : 'FAIL'} (${r.detail})`);
      if (report) await loadFailed(report.runId);
      if (r.task?.status === 'failed') setFailedTasks((prev) => [r.task!, ...prev.filter((t) => t.id !== r.task!.id)]);
    } finally {
      setBusy(false);
    }
  }

  const paymentScore = report ? scorePayments(report, paymentsGolden.expected as never) : null;
  const developerFavours = judgement
    ? [...judgement.rows, ...judgement.others].filter((r) => r.direction === 'favours_developer')
    : [];
  const isDeveloperQuestion = /developer|promoter|builder/i.test(askQuery);
  const favourScore = judgement && isDeveloperQuestion ? scoreDeveloperFavour(judgement.rows, developerGolden.expected) : null;
  const paymentRows = report ? report.clauses.flatMap((c) => c.payments.map((p) => ({ ...p, clause: c.clauseNo }))) : [];

  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif', maxWidth: 1240 }}>
      <h2>Analysis</h2>
      <div>
        Document:{' '}
        <select value={docId ?? ''} onChange={(e) => setDocId(e.target.value || null)} style={{ minWidth: 320 }}>
          <option value="">-- select a ready document --</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>{d.name} ({d.pageCount}p, {d.chunkCount} chunks)</option>
          ))}
        </select>{' '}
        <button disabled={busy || !docId || !session} onClick={analyse}>Run analysis</button>{' '}
        <button disabled={busy || !docId} onClick={clearLocal}>Clear local analysis</button>{' '}
        <button disabled={busy || !docId} onClick={restore}>Restore from Supabase</button>
      </div>
      <div style={{ marginTop: 8 }}>Model: {ANALYSIS_MODEL} · fallback: {FALLBACK_MODEL ?? '(none)'}</div>
      <div>Progress: {progress || '-'}</div>
      {source && <div>Report source: <b>{source}</b></div>}

      {report && (
        <>
          <h3>Report</h3>
          <div>{report.docName} · run {report.runId.slice(0, 8)} · {new Date(report.createdAt).toLocaleString()}</div>
          <div><b>{ledgerSummary(report.ledger)}</b></div>
          <div style={{ fontSize: 12, color: '#555' }}>
            skipped clauses: {report.resolution?.skippedClauses ?? 0} · pages corrected: {report.resolution?.pageCorrected ?? 0} ·
            dropped items: {report.resolution?.dropped ?? report.drops.length} · pages checked: {report.ledger.totals.citedPages.length}
          </div>
          <ul>
            {report.overview.map((s, i) => (
              <li key={i}>{s.text} <span style={{ color: '#888', fontSize: 11 }}>[{s.cites.join(', ')}]</span></li>
            ))}
            {report.overview.length === 0 && <li>(no overview sentences passed citation checks)</li>}
          </ul>
          {report.notices.map((n) => <div key={n} style={{ fontSize: 11, color: '#a00' }}>{n}</div>)}

          <h4>Metrics</h4>
          <table border={1} cellPadding={3}>
            <tbody>
              <tr><td>calls</td><td>{report.metrics.calls}</td><td>prompt tokens</td><td>{report.metrics.promptTokens}</td></tr>
              <tr><td>completion tokens</td><td>{report.metrics.completionTokens}</td><td>cost</td><td>{money(report.metrics.costUsd)}</td></tr>
              <tr><td>p95 duration</td><td>{Math.round(report.metrics.p95DurationMs)} ms</td><td>p95 output</td><td>{report.metrics.p95CompletionTokens} tokens</td></tr>
              <tr><td>retried</td><td>{report.metrics.retried}</td><td>split</td><td>{report.metrics.split}</td></tr>
              <tr><td>failed</td><td>{report.metrics.failed}</td><td>empty_output</td><td>{report.metrics.emptyOutput}</td></tr>
              <tr><td>tasks</td><td>{report.metrics.doneTasks}/{report.metrics.totalTasks} done</td><td>next budget</td><td>{report.metrics.recommendedMaxTokens ?? '-'}</td></tr>
            </tbody>
          </table>

          {paymentScore && (
            <>
              <h4>Payment recall (golden)</h4>
              <div>
                model-only <b>{paymentScore.modelFound}/{paymentScore.expected} ({pct(paymentScore.modelRecall)})</b> ·
                model + code <b>{paymentScore.combinedFound}/{paymentScore.expected} ({pct(paymentScore.combinedRecall)})</b>
              </div>
              {paymentScore.combinedMisses.length > 0 && (
                <div style={{ fontSize: 12 }}>
                  still missing: {paymentScore.combinedMisses.map((m) => `${m.clause} ${m.label}`).join('; ')}
                </div>
              )}
            </>
          )}

          <h4>Coverage ledger</h4>
          <table border={1} cellPadding={3}>
            <thead><tr><th>chunk</th><th>pages</th><th>processed</th><th>detected</th><th>analysed</th><th>verified</th><th>skipped</th><th>items</th></tr></thead>
            <tbody>
              {report.ledger.chunks.map((c) => (
                <tr key={c.chunkId}>
                  <td>{c.index}</td><td>{c.pages[0]}-{c.pages[1]}</td><td>{c.processed ? 'yes' : 'no'}</td>
                  <td>{c.detected}</td><td>{c.analysed}</td><td>{c.verified}</td>
                  <td>{(c.skipped ?? []).join(', ')}</td><td>{c.itemsVerified}/{c.itemsAnalysed}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4>Payment dates (verified) — {paymentRows.length}</h4>
          <table border={1} cellPadding={3}>
            <thead><tr><th>clause</th><th>amount</th><th>payer → payee</th><th>due / date text</th><th>page</th></tr></thead>
            <tbody>
              {paymentRows.map((p) => (
                <tr key={p.itemId}><td>{p.clause}</td><td>{p.amount}</td><td>{p.payer} → {p.payee}</td><td>{p.due}</td><td>{p.page}</td></tr>
              ))}
            </tbody>
          </table>

          <h4>Code-extracted amounts (unclassified) — {(report.amounts?.code ?? []).length}</h4>
          <div style={{ fontSize: 12, color: '#666' }}>Found by code; not model payments. Shown separately and never merged into the verified payments.</div>
          <table border={1} cellPadding={3} style={{ marginTop: 6 }}>
            <thead><tr><th>clause</th><th>kind</th><th>text</th><th>page</th></tr></thead>
            <tbody>
              {(report.amounts?.code ?? []).slice(0, 60).map((a, i) => (
                <tr key={i}><td>{a.clause}</td><td>{a.kind}</td><td>{a.text}</td><td>{a.page}</td></tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 6 }}>
            <b>Uncaptured amounts ({(report.amounts?.uncaptured ?? []).length}):</b>{' '}
            {(report.amounts?.uncaptured ?? []).map((a) => `${a.clause}:${a.text}`).join(' · ') || '(none)'}
          </div>

          <h4>Clauses ({report.clauses.length})</h4>
          <table border={1} cellPadding={3}>
            <thead><tr><th>clause</th><th>type</th><th>summary</th><th>oblig.</th><th>dates</th><th>payments</th><th>risks</th><th>verified items</th></tr></thead>
            <tbody>
              {report.clauses.map((c) => (
                <tr key={c.itemId}>
                  <td>{c.clauseNo}</td><td>{c.type}</td><td style={{ maxWidth: 420 }}>{c.summary}</td>
                  <td>{c.obligations.length}</td><td>{c.dates.length}</td><td>{c.payments.length}</td><td>{c.risks.length}</td><td>{c.verifiedItems}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <details style={{ marginTop: 8 }}>
            <summary>Dropped unverified items ({report.drops.length})</summary>
            <table border={1} cellPadding={2}>
              <thead><tr><th>clause</th><th>kind</th><th>reason</th><th>page</th><th>quote</th></tr></thead>
              <tbody>
                {report.drops.slice(0, 100).map((d, i) => (
                  <tr key={i}><td>{d.clauseNo}</td><td>{d.kind}</td><td>{d.reason}</td><td>{d.page ?? ''}</td><td>{d.quote.slice(0, 80)}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}

      <h4>Failed tasks (last run)</h4>
      <table border={1} cellPadding={3}>
        <thead><tr><th>task</th><th>attempts</th><th>failure</th><th>finish</th><th>model</th></tr></thead>
        <tbody>
          {failedTasks.map((t) => (
            <tr key={t.id}><td>{t.id.slice(-12)}</td><td>{t.attemptNo}</td><td>{t.failureCode}</td><td>{t.finishReason}</td><td>{t.model}</td></tr>
          ))}
          {failedTasks.length === 0 && <tr><td colSpan={5}>(none)</td></tr>}
        </tbody>
      </table>
      {forced && <div>Forced failure check: <b style={{ color: forced.pass ? 'green' : 'red' }}>{forced.pass ? 'PASS' : 'FAIL'}</b> — {forced.detail}</div>}
      {fb && <div>Fallback check: <b style={{ color: fb.pass ? 'green' : 'red' }}>{fb.pass ? 'PASS' : 'FAIL'}</b> — {fb.detail}</div>}

      <h4>Ask / Judge</h4>
      <div>
        <select value={askMode} onChange={(e) => setAskMode(e.target.value as 'retrieval' | 'whole')}>
          <option value="retrieval">Retrieval answer</option>
          <option value="whole">Whole document / judgement</option>
        </select>{' '}
        <input value={askQuery} onChange={(e) => setAskQuery(e.target.value)} style={{ width: 520 }} />{' '}
        <button disabled={busy || !docId || !session} onClick={runAskOrJudge}>Ask</button>
      </div>

      {ask && (
        <div style={{ marginTop: 8 }}>
          <div><b>{ask.notFound ? 'NOT FOUND' : 'Answer'}:</b> {ask.answer}</div>
          {ask.citations.length > 0 && (
            <ul>
              {ask.citations.map((c, i) => (
                <li key={i}>{c.text} <span style={{ color: '#888' }}>[p{c.page} {c.clause_no}]</span><br /><small>{c.quote}</small></li>
              ))}
            </ul>
          )}
          {ask.chunks.length > 0 && (
            <details>
              <summary>Retrieved chunks ({ask.chunks.length})</summary>
              <table border={1} cellPadding={2}>
                <thead><tr><th>pages</th><th>clauses</th><th>fused</th><th>vector</th><th>keyword</th></tr></thead>
                <tbody>
                  {ask.chunks.map((c) => (
                    <tr key={c.chunkId}><td>{c.pageStart}-{c.pageEnd}</td><td>{c.clauses.join(', ')}</td><td>{c.fused.toFixed(4)}</td><td>{c.vectorScore.toFixed(3)}</td><td>{c.keywordScore.toFixed(2)}</td></tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}

      {judgement && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 13 }}>
            Chunks read {judgement.counts.chunksRead} · proposed {judgement.counts.proposed} · verified {judgement.counts.verified} ·
            dropped {JSON.stringify(judgement.counts.dropped)} · page corrected {judgement.counts.pageCorrected} ·
            directions D/S/N {judgement.counts.directions.favours_developer}/{judgement.counts.directions.favours_society}/{judgement.counts.directions.neutral}
          </div>
          <div><b>{judgement.summary}</b></div>
          {favourScore && (
            <div>
              Developer-favour recall <b>{favourScore.found}/{favourScore.expected} ({pct(favourScore.recall)})</b>
              {favourScore.misses.length > 0 && <span> · misses: {favourScore.misses.join(', ')}</span>}
              {favourScore.falseFavours.length > 0 && <span style={{ color: '#a00' }}> · false favours: {favourScore.falseFavours.map((f) => f.clause).join(', ')}</span>}
            </div>
          )}
          <table border={1} cellPadding={3} style={{ marginTop: 6 }}>
            <thead><tr><th>clause</th><th>page</th><th>direction</th><th>why</th><th>verified quote</th></tr></thead>
            <tbody>
              {judgement.rows.map((r) => (
                <tr key={r.clause}>
                  <td>{r.clause}</td><td>{r.page}</td><td>{r.direction}</td>
                  <td style={{ maxWidth: 320 }}>{r.why}</td>
                  <td style={{ maxWidth: 420 }}>{r.quote}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {judgement.others.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary>Other findings ({judgement.others.length})</summary>
              <table border={1} cellPadding={3}>
                <thead><tr><th>clause</th><th>page</th><th>direction</th><th>why</th><th>verified quote</th></tr></thead>
                <tbody>
                  {judgement.others.map((r) => (
                    <tr key={r.clause}><td>{r.clause}</td><td>{r.page}</td><td>{r.direction}</td><td>{r.why}</td><td>{r.quote}</td></tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          <h4>All favours_developer items ({developerFavours.length}) — review each quote</h4>
          <table border={1} cellPadding={3}>
            <thead><tr><th>clause</th><th>page</th><th>why</th><th>quote</th><th>obligation-shaped?</th></tr></thead>
            <tbody>
              {developerFavours.map((r) => (
                <tr key={r.clause}>
                  <td>{r.clause}</td><td>{r.page}</td><td>{r.why}</td><td>{r.quote}</td>
                  <td>{looksLikeDeveloperObligation(r.quote, r.why) ? 'YES — check' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4>Checks</h4>
      <div>
        <button disabled={busy || !docId || !session} onClick={checkFailure}>Forced failure (bad model)</button>{' '}
        <button disabled={busy || !docId || !session} onClick={checkFallback}>Fallback check</button>
      </div>

      <h4>Log</h4>
      <pre style={{ maxHeight: 260, overflow: 'auto' }}>{log.join('\n')}</pre>
      <div style={{ fontSize: 11, color: '#666' }}>
        {judgement && `judgement calls ${judgement.metrics.calls}, completion ${judgement.metrics.completionTokens}, cost ${money(judgement.metrics.costUsd)}. `}
      </div>
    </div>
  );
}
