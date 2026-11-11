import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import { openHarnessDb, type HarnessDBHandle, type AnalysisReportRecord, type DocumentRecord } from '../runner/db';
import { RetrievalClient } from '../retrieval/client';
import { runAnalysis } from '../analysis/runAnalysis';
import { ANALYSIS_MODEL, FALLBACK_MODEL } from '../analysis/config';
import { goldenDocName, type GoldenFile } from '../analysis/goldenScore';
import type { AnalysisReport } from '../analysis/types';
import { aggregateScores, scoreDocument } from '../quality/score';
import type { AggregateScore, DocumentScore } from '../quality/types';
import { DEFAULT_THRESHOLDS } from '../quality/config';
import {
  BUCKET_LABEL,
  REGRESSION_SET,
  enabledEntries,
  entryMatchesDocument,
  goldenForEntry,
} from '../quality/regression';
import {
  compareScores,
  loadHistory,
  previousScore,
  saveScore,
  type StoredScore,
} from '../quality/history';
import { runRepeatComparison, type RepeatComparison } from '../quality/repeat';

const GOLDEN_FILES = import.meta.glob('../../tests/golden/*.json', { eager: true, import: 'default' }) as Record<
  string,
  GoldenFile
>;
const GOLDEN: Record<string, GoldenFile> = Object.fromEntries(
  Object.entries(GOLDEN_FILES).map(([path, file]) => [path.split('/').pop()!.replace(/\.json$/, ''), file]),
);

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const TEST_EMAIL = import.meta.env.VITE_TEST_EMAIL as string | undefined;
const TEST_PASSWORD = import.meta.env.VITE_TEST_PASSWORD as string | undefined;

const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const money = (n: number) => `$${n.toFixed(4)}`;
const delta = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(0)}%`;

function goldenForDoc(docName: string): GoldenFile | null {
  return Object.values(GOLDEN).find((g) => goldenDocName(g) === docName) ?? null;
}

export function QualityPage() {
  const [db, setDb] = useState<HarnessDBHandle | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [reports, setReports] = useState<Record<string, AnalysisReport>>({});
  const [scores, setScores] = useState<Record<string, DocumentScore>>({});
  const [history, setHistory] = useState<StoredScore[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [aggregate, setAggregate] = useState<AggregateScore | null>(null);
  const [repeat, setRepeat] = useState<{ comparison: RepeatComparison; first: string; second: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const clientRef = useRef<RetrievalClient | null>(null);

  const addLog = (line: string) => setLog((l) => [...l.slice(-300), `${new Date().toLocaleTimeString()} ${line}`]);

  useEffect(() => {
    openHarnessDb().then(async (handle) => {
      setDb(handle);
      setDocs((await handle.getAll('documents')).sort((a, b) => b.createdAt - a.createdAt));
      const records = (await handle.getAll('analysis_reports')) as AnalysisReportRecord[];
      const latest: Record<string, AnalysisReport> = {};
      for (const r of records.sort((a, b) => a.savedAt - b.savedAt)) latest[r.docId] = r.report as AnalysisReport;
      setReports(latest);
      setHistory(loadHistory(localStorage));
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

  const selectedReport = selectedDoc ? reports[selectedDoc] ?? null : null;
  const selectedScore = selectedReport ? scores[selectedReport.runId] ?? null : null;
  const selectedPrevious = selectedScore ? previousScore(history, selectedScore) : null;

  const scoreReport = useMemo(
    () =>
      async (report: AnalysisReport, golden: GoldenFile): Promise<DocumentScore | null> => {
        if (!db) return null;
        const pageRecs = await db.getAll(
          'pages',
          IDBKeyRange.bound([report.docId, 0], [report.docId, Number.MAX_SAFE_INTEGER]),
        );
        const pages = new Map(pageRecs.map((p) => [p.pageNo, p.text]));
        const tasks = await db.getAllFromIndex('tasks', 'byRun', report.runId);
        return scoreDocument({ report, golden, pages, tasks, thresholds: DEFAULT_THRESHOLDS });
      },
    [db],
  );

  // Score the selected saved run locally (no model call) when it is opened.
  useEffect(() => {
    if (!selectedReport) return;
    if (scores[selectedReport.runId]) return;
    const golden = goldenForDoc(selectedReport.docName);
    if (!golden) return;
    let cancelled = false;
    (async () => {
      const s = await scoreReport(selectedReport, golden);
      if (s && !cancelled) setScores((prev) => ({ ...prev, [s.runId]: s }));
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedReport, scores, scoreReport]);

  async function runAll() {
    if (!db) return;
    setBusy(true);
    try {
      const next = { ...scores };
      for (const entry of enabledEntries()) {
        const golden = goldenForEntry(entry, GOLDEN);
        const report = Object.values(reports).find((r) => entryMatchesDocument(entry, r.docName, golden));
        if (!golden || !report) {
          addLog(`${entry.label}: no saved run or golden file`);
          continue;
        }
        const s = await scoreReport(report, golden);
        if (!s) continue;
        next[s.runId] = s;
        saveScore(localStorage, s);
        addLog(`${entry.label}: ${s.pass ? 'PASS' : 'FAIL'} (${s.failures.join('; ') || 'all thresholds met'})`);
      }
      setScores(next);
      setHistory(loadHistory(localStorage));
      setAggregate(aggregateScores(Object.values(next)));
    } finally {
      setBusy(false);
    }
  }

  async function runTwice() {
    if (!db || !selectedDoc || !session || !clientRef.current) return;
    const doc = docs.find((d) => d.id === selectedDoc);
    if (!doc) return;
    setBusy(true);
    setRepeat(null);
    setProgress('repeat run: first analysis');
    try {
      const run = () =>
        runAnalysis({
          db,
          supabase: sb,
          accessToken: session.access_token,
          userId: session.user.id,
          functionsUrl: `${SUPABASE_URL}/functions/v1`,
          anonKey: ANON_KEY,
          docId: doc.id,
          model: ANALYSIS_MODEL,
          fallbackModel: FALLBACK_MODEL,
          reasoning: { effort: 'minimal' },
          maxTokens: undefined,
          lawSearch: async (text, k) => clientRef.current!.lawSearch(text, k).then((x) => x.results),
          docSearch: async (q, k) => {
            const r = await clientRef.current!.search(doc.id, q, k);
            if (!r || !Array.isArray(r.results)) throw new Error('search returned no result list');
            return r.results;
          },
          onProgress: (m) => setProgress(`repeat run: ${m}`),
          onLog: addLog,
        });

      const result = await runRepeatComparison(run);
      setReports((prev) => ({
        ...prev,
        [result.first.docId]: result.first,
        [result.second.docId]: result.second,
      }));
      setRepeat({
        comparison: result.comparison,
        first: result.first.runId,
        second: result.second.runId,
      });
      addLog(
        `repeat run: ${result.comparison.counts.overlap} matched, ${result.comparison.counts.onlyInFirst} only in first, ${result.comparison.counts.onlyInSecond} only in second`,
      );

      const golden = goldenForDoc(result.first.docName);
      if (golden) {
        const a = await scoreReport(result.first, golden);
        const b = await scoreReport(result.second, golden);
        if (a && b) {
          setScores((prev) => ({ ...prev, [a.runId]: a, [b.runId]: b }));
          saveScore(localStorage, a);
          saveScore(localStorage, b);
          setHistory(loadHistory(localStorage));
        }
      }
      setProgress('repeat run: done');
    } catch (e) {
      addLog(`repeat run failed: ${String(e)}`);
      setProgress(`error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const rows = Object.values(reports)
    .map((r) => ({ report: r, golden: goldenForDoc(r.docName), score: scores[r.runId] ?? null }))
    .sort((a, b) => a.report.docName.localeCompare(b.report.docName));

  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif', maxWidth: 1500 }}>
      <h2>Quality suite</h2>
      <div style={{ fontSize: 12, color: '#555', maxWidth: 980 }}>
        Scores are read from saved runs. No model call is made here except the repeat-run comparison.
        Hold-out golden files are scored but excluded from the tuning aggregate. Thresholds:{' '}
        payment model {pct(DEFAULT_THRESHOLDS.paymentRecallModel)} / +code {pct(DEFAULT_THRESHOLDS.paymentRecallCombined)},
        date {pct(DEFAULT_THRESHOLDS.dateRecall)}, obligation {pct(DEFAULT_THRESHOLDS.obligationRecall)},
        favour {pct(DEFAULT_THRESHOLDS.favourRecall)}, precision {pct(DEFAULT_THRESHOLDS.precision)},
        quotes {pct(DEFAULT_THRESHOLDS.quoteValidity)}, overview {pct(DEFAULT_THRESHOLDS.overviewFidelity)},
        false missing {DEFAULT_THRESHOLDS.maxFalseMissingClaims}, failed tasks {DEFAULT_THRESHOLDS.maxFailedTasks}.
      </div>

      <div style={{ marginTop: 10 }}>
        <button disabled={busy} onClick={runAll}>Run all (score saved runs)</button>{' '}
        <select value={selectedDoc ?? ''} onChange={(e) => setSelectedDoc(e.target.value || null)} style={{ minWidth: 320 }}>
          <option value="">-- select a document --</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>{d.name} ({d.pageCount}p)</option>
          ))}
        </select>{' '}
        <button disabled={busy || !selectedDoc || !session} onClick={runTwice} title="Makes two paid analysis runs">
          Run twice and compare
        </button>
      </div>
      <div style={{ marginTop: 6 }}>Progress: {progress || '-'}</div>

      {aggregate && (
        <>
          <h3>Aggregate</h3>
          <table border={1} cellPadding={3}>
            <thead>
              <tr><th></th><th>documents</th><th>recall (model)</th><th>recall (+code)</th><th>precision</th><th>quotes</th><th>overview</th><th>false missing</th><th>failed</th><th>calls</th><th>cost</th><th>passed</th></tr>
            </thead>
            <tbody>
              {(['tuning', 'holdout'] as const).map((name) => {
                const b = aggregate[name];
                return (
                  <tr key={name}>
                    <td><b>{name}</b></td><td>{b.documents}</td><td>{pct(b.recall.model)}</td><td>{pct(b.recall.combined)}</td>
                    <td>{pct(b.precision)}</td><td>{pct(b.quoteValidity)}</td><td>{pct(b.overviewFidelity)}</td>
                    <td>{b.falseMissingClaims}</td><td>{b.failedTasks}</td><td>{b.calls}</td><td>{money(b.costUsd)}</td>
                    <td>{b.passed}/{b.documents}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      <h3>Documents</h3>
      <table border={1} cellPadding={3}>
        <thead>
          <tr>
            <th>document</th><th>set</th><th>golden</th><th>expected</th><th>payment (model / +code)</th>
            <th>date</th><th>obligation</th><th>favour</th><th>precision</th><th>quotes</th><th>false missing</th>
            <th>ledger</th><th>overview</th><th>calls</th><th>cost</th><th>p95 task</th><th>failed</th>
            <th>result</th><th>change vs previous</th><th>misses</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ report, golden, score }) => {
            const prev = score ? previousScore(history, score) : null;
            const d = prev && score ? compareScores(prev.score, score) : null;
            return (
              <tr key={report.runId} style={{ background: golden?.holdout ? '#fff8e1' : undefined }}>
                <td style={{ maxWidth: 260 }}>{report.docName}<div style={{ fontSize: 10, color: '#777' }}>run {report.runId.slice(0, 8)}</div></td>
                <td>{golden ? (golden.holdout ? <b>HOLD-OUT</b> : 'tuning') : '-'}</td>
                <td>{golden ? (golden.doc ?? golden.document ?? '?') : <span style={{ color: '#a00' }}>no golden file</span>}</td>
                {score ? (
                  <>
                    <td>{score.expected}</td>
                    <td>{pct(score.recall.payment.modelRecall)} / {pct(score.recall.payment.combinedRecall)}</td>
                    <td>{pct(score.recall.date.modelRecall)}</td>
                    <td>{pct(score.recall.obligation.modelRecall)}</td>
                    <td>{score.recall.favour.available ? pct(score.recall.favour.modelRecall) : 'n/a'}</td>
                    <td>{pct(score.precision.overall.precision)}</td>
                    <td>{pct(score.quoteValidity.rate)} ({score.quoteValidity.invalid.length} bad)</td>
                    <td>{score.falseMissing.falseClaims.length}/{score.falseMissing.claims}</td>
                    <td>{score.ledger.ok ? 'ok' : 'MISMATCH'}</td>
                    <td>{pct(score.overview.rate)} ({score.overview.issues.length} bad)</td>
                    <td>{score.metrics.calls}</td>
                    <td>{money(score.metrics.costUsd)}</td>
                    <td>{Math.round(score.metrics.p95DurationMs)} ms</td>
                    <td>{score.metrics.failed}</td>
                    <td style={{ color: score.pass ? 'green' : '#a00' }}><b>{score.pass ? 'PASS' : 'FAIL'}</b></td>
                    <td style={{ fontSize: 11 }}>
                      {d ? (
                        <>
                          recall {delta(d.modelRecall)} · precision {delta(d.precision)} · quotes {delta(d.quoteValidity)} · {d.pass}
                        </>
                      ) : 'no previous run'}
                    </td>
                    <td><a href="#misses" onClick={() => setSelectedDoc(report.docId)}>open</a></td>
                  </>
                ) : (
                  <td colSpan={16} style={{ fontSize: 12, color: '#777' }}>not scored yet — select it or press “Run all”</td>
                )}
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={20}>(no saved analysis reports)</td></tr>}
        </tbody>
      </table>

      <h3>Regression set</h3>
      <table border={1} cellPadding={3}>
        <thead><tr><th>bucket</th><th>label</th><th>golden file</th><th>status</th></tr></thead>
        <tbody>
          {REGRESSION_SET.map((e) => {
            const golden = goldenForEntry(e, GOLDEN);
            const report = Object.values(reports).find((r) => entryMatchesDocument(e, r.docName, golden));
            return (
              <tr key={e.label}>
                <td>{BUCKET_LABEL[e.bucket]}</td><td>{e.label}</td><td>{e.goldenFile || '(none yet)'}</td>
                <td>{!e.enabled ? 'disabled' : !golden ? 'missing golden' : report ? 'saved run found' : 'no saved run'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {selectedReport && (
        <>
          <h3 id="misses">Misses, drops and failures — {selectedReport.docName}</h3>
          {selectedScore ? (
            <>
              <div style={{ color: selectedScore.pass ? 'green' : '#a00' }}>
                <b>{selectedScore.pass ? 'PASS' : 'FAIL'}</b>{' '}
                {selectedScore.failures.length > 0 ? selectedScore.failures.join('; ') : 'all thresholds met'}
              </div>
              <div style={{ fontSize: 12, color: '#555' }}>
                tasks {selectedScore.metrics.doneTasks}/{selectedScore.metrics.totalTasks} done · failed {selectedScore.metrics.failed} ·
                calls {selectedScore.metrics.calls} · cost {money(selectedScore.metrics.costUsd)} · p95 task {Math.round(selectedScore.metrics.p95DurationMs)} ms
                {selectedPrevious && <> · previous run {selectedPrevious.score.runId.slice(0, 8)} ({selectedPrevious.score.pass ? 'PASS' : 'FAIL'})</>}
              </div>

              <h4>Missed expectations</h4>
              {!selectedScore.recall.favour.available && (
                <div style={{ fontSize: 12, color: '#a60' }}>
                  Favour recall is not measured: this saved run has no judgement snapshot. Run Ask / Judge on the
                  analysis page to attach one.
                </div>
              )}
              <ul style={{ fontSize: 13 }}>
                {Object.values(selectedScore.recall).filter((r) => r.available).flatMap((r) =>
                  r.modelMisses.map((m) => (
                    <li key={`${r.kind}-${m.clause}-${m.token}`}>
                      {r.kind} clause {m.clause} “{m.token}” — model missed
                      {r.kind === 'payment' && r.combinedMisses.some((x) => x.clause === m.clause && x.token === m.token)
                        ? ' and code amounts did not recover it'
                        : r.kind === 'payment'
                          ? ' (recovered by code-extracted amounts)'
                          : ''}
                      {m.reason ? ` — ${m.reason}` : ''}
                    </li>
                  )),
                )}
                {Object.values(selectedScore.recall)
                  .filter((r) => r.available)
                  .every((r) => r.modelMisses.length === 0) && <li>(none)</li>}
              </ul>

              <h4>Invalid or mis-cited quotes ({selectedScore.quoteValidity.invalid.length})</h4>
              <table border={1} cellPadding={2}>
                <thead><tr><th>kind</th><th>clause</th><th>cited page</th><th>reason</th><th>found page</th><th>quote</th></tr></thead>
                <tbody>
                  {selectedScore.quoteValidity.invalid.map((q, i) => (
                    <tr key={i}><td>{q.kind}</td><td>{q.clause}</td><td>{q.page ?? ''}</td><td>{q.reason}</td><td>{q.foundPage ?? ''}</td><td>{q.quote.slice(0, 100)}</td></tr>
                  ))}
                  {selectedScore.quoteValidity.invalid.length === 0 && <tr><td colSpan={6}>(none)</td></tr>}
                </tbody>
              </table>

              <h4>False “missing” claims ({selectedScore.falseMissing.falseClaims.length})</h4>
              <ul style={{ fontSize: 13 }}>
                {selectedScore.falseMissing.falseClaims.map((c, i) => (
                  <li key={i}>{c.text} <b>— topic appears on page {c.foundOnPage}</b></li>
                ))}
                {selectedScore.falseMissing.falseClaims.length === 0 && <li>(none)</li>}
              </ul>

              <h4>Overview fidelity issues ({selectedScore.overview.issues.length})</h4>
              <table border={1} cellPadding={2}>
                <thead><tr><th>sentence</th><th>unknown cites</th><th>unsupported figures</th></tr></thead>
                <tbody>
                  {selectedScore.overview.issues.map((o, i) => (
                    <tr key={i}><td style={{ maxWidth: 620 }}>{o.text}</td><td>{o.unknownCites.join(', ')}</td><td>{o.unsupportedFigures.join(', ')}</td></tr>
                  ))}
                  {selectedScore.overview.issues.length === 0 && <tr><td colSpan={3}>(none)</td></tr>}
                </tbody>
              </table>

              <details style={{ marginTop: 8 }}>
                <summary>Ledger checks ({selectedScore.ledger.mismatches.length} mismatches)</summary>
                <table border={1} cellPadding={2}>
                  <thead><tr><th>check</th><th>ok</th><th>detail</th></tr></thead>
                  <tbody>
                    {selectedScore.ledger.checks.map((c) => (
                      <tr key={c.name}><td>{c.name}</td><td>{c.ok ? 'yes' : 'NO'}</td><td>{c.detail}</td></tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>
          ) : (
            <div style={{ fontSize: 13 }}>No golden file for this document.</div>
          )}

          <h4>Dropped unverified items ({selectedReport.drops.length})</h4>
          <details>
            <summary>Show dropped items</summary>
            <table border={1} cellPadding={2}>
              <thead><tr><th>clause</th><th>kind</th><th>reason</th><th>page</th><th>quote</th></tr></thead>
              <tbody>
                {selectedReport.drops.slice(0, 200).map((d, i) => (
                  <tr key={i}><td>{d.clauseNo}</td><td>{d.kind}</td><td>{d.reason}</td><td>{d.page ?? ''}</td><td>{d.quote.slice(0, 100)}</td></tr>
                ))}
                {selectedReport.drops.length === 0 && <tr><td colSpan={5}>(none)</td></tr>}
              </tbody>
            </table>
          </details>
        </>
      )}

      {repeat && (
        <>
          <h3>Repeat-run comparison</h3>
          <div>
            first {repeat.first.slice(0, 8)} · second {repeat.second.slice(0, 8)} · items {repeat.comparison.counts.first} /{' '}
            {repeat.comparison.counts.second} · overlap <b>{repeat.comparison.counts.overlap}</b> · only in first{' '}
            <b>{repeat.comparison.counts.onlyInFirst}</b> · only in second <b>{repeat.comparison.counts.onlyInSecond}</b>
          </div>
          <table border={1} cellPadding={3}>
            <thead><tr><th>kind</th><th>first</th><th>second</th><th>overlap</th><th>only first</th><th>only second</th></tr></thead>
            <tbody>
              {Object.entries(repeat.comparison.byKind).map(([kind, c]) => (
                <tr key={kind}><td>{kind}</td><td>{c.first}</td><td>{c.second}</td><td>{c.overlap}</td><td>{c.onlyInFirst}</td><td>{c.onlyInSecond}</td></tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary>Items found in only one run ({repeat.comparison.onlyInFirst.length + repeat.comparison.onlyInSecond.length})</summary>
            <table border={1} cellPadding={2}>
              <thead><tr><th>run</th><th>kind</th><th>clause</th><th>page</th><th>quote</th></tr></thead>
              <tbody>
                {repeat.comparison.onlyInFirst.map((x, i) => (
                  <tr key={`a-${i}`}><td>first</td><td>{x.kind}</td><td>{x.clause}</td><td>{x.page}</td><td>{x.quote.slice(0, 120)}</td></tr>
                ))}
                {repeat.comparison.onlyInSecond.map((x, i) => (
                  <tr key={`b-${i}`}><td>second</td><td>{x.kind}</td><td>{x.clause}</td><td>{x.page}</td><td>{x.quote.slice(0, 120)}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}

      <h3>Golden format</h3>
      <pre style={{ background: '#f6f6f6', padding: 8, fontSize: 11 }}>
{`tests/golden/<doc>.json
{
  "doc": "<exact report.docName>", "holdout": false, "note": "...",
  "expected": [
    { "clause": "13", "token": "18,000", "kind": "payment", "reason": "..." },
    { "clause": "2",  "token": "31 March 2027", "kind": "date" },
    { "clause": "5",  "token": "register", "kind": "obligation" },
    { "clause": "30(l)", "token": "alpha", "kind": "favour", "contains": "debris" },
    { "clause": "22", "token": "interest", "kind": "risk" }
  ],
  "removed": [{ "clause": "17", "token": "alpha", "kind": "favour", "reason": "burden on that party" }]
}`}
      </pre>

      <h3>Log</h3>
      <pre style={{ maxHeight: 260, overflow: 'auto' }}>{log.join('\n')}</pre>
    </div>
  );
}
