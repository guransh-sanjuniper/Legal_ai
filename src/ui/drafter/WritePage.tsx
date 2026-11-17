import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../app/pages/Placeholder';
import { assemble, exportGate } from '../../drafter/assemble';
import { isOutlineStale } from '../../drafter/outline';
import { useDeveloperMode } from '../devMode';
import { sourceTextReady, sourceTextStale } from '../../drafter/resolveRef';
import { itemFingerprint, renderClauseText } from '../../drafter/write';
import { estimateWriting } from '../../drafter/writeEstimate';
import { getDraft, openDrafterDb, type DrafterDBHandle } from '../../drafter/store';
import type { ClauseRecord, DraftRecord, OutlineItem, WriteRun } from '../../drafter/types';
import type { DocAlias } from '../../drafter/plan';
import { loadDrafterLibrary } from './library';
import { planDocsForDraft } from './planRun';
import {
  draftWriteLockHeld,
  isWriting,
  startWriting,
  stopWriting,
  subscribeWriting,
} from './writeRunner';
import {
  analyseWriteState,
  decideWriteStart,
  sourceGate,
  writeProgress,
  writeStartReason,
  type WriteStartAction,
} from './writeProgress';
import './drafter.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function formatRunDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function withPlaceholders(text: string): ReactNode[] {
  return text.split(/(\[●[^\]]*\])/g).map((part, index) =>
    part.startsWith('[●') ? (
      <mark key={index} className="drafter-write-mark">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function countPlaceholders(text: string): number {
  return (text.match(/\[●/g) ?? []).length;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function WritePage() {
  const { draftId } = useParams();
  const [devOn] = useDeveloperMode();
  const navigate = useNavigate();

  const [db, setDb] = useState<DrafterDBHandle | null>(null);
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [docs, setDocs] = useState<DocAlias[]>([]);
  const [clauses, setClauses] = useState<Record<string, ClauseRecord>>({});
  const [run, setRun] = useState<WriteRun | null>(null);
  const [writingNow, setWritingNow] = useState(0);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startBlocked, setStartBlocked] = useState<'lock' | 'error' | null>(null);
  const [startCheckDone, setStartCheckDone] = useState(false);
  const [autoDecision, setAutoDecision] = useState<WriteStartAction | null>(null);

  const visitDraftRef = useRef<string | null>(null);
  const autoStartRef = useRef(false);
  const userStoppedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!draftId) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      let handle: DrafterDBHandle;
      try {
        handle = await openDrafterDb();
      } catch (e) {
        if (!alive) return;
        setError(`Could not open drafts on this device: ${errorText(e)}`);
        setNotFound(true);
        setLoading(false);
        return;
      }
      if (!alive) return;
      setDb(handle);
      try {
        const entries = await loadDrafterLibrary().catch(() => []);
        if (!alive) return;
        const found = await getDraft(handle, draftId);
        if (!alive) return;
        if (!found) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        setDraft(found);
        setDocs(planDocsForDraft(found, entries));
        setClauses(found.clauses);
        setRun(found.writeRun);
        setRunning(isWriting(found.id));
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(`Could not open the draft: ${errorText(e)}`);
        setNotFound(true);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [draftId]);

  // Listeners are kept by the runner even before a run starts, so the progress bar updates
  // from the engine's per-section saves and a revisit can attach to a run in progress.
  useEffect(() => {
    if (!draft) return;
    setRunning(isWriting(draft.id));
    return subscribeWriting(draft.id, (live) => {
      setClauses(live.clauses);
      setRun(live.run);
      setWritingNow(live.writing);
      setRunning(live.active);
      if (!live.active) {
        setStopping(false);
        // The engine's final save may be newer than this page's draft object (a revisit
        // attached to another page's run). Re-read before showing the finished gate.
        void refresh();
      }
    });
  }, [draft?.id]);

  useEffect(() => {
    if (!running || !db || !draft) return;
    const timer = setInterval(() => {
      void refresh();
    }, 1000);
    return () => clearInterval(timer);
  }, [running, db, draft?.id]);

  // One automatic start per page visit. The ref survives StrictMode's double effect; the
  // runner's own "already running" check is the second guard.
  useEffect(() => {
    if (loading || !db || !draft) return;

    // A different draft in the same mounted route is a new page visit.
    if (visitDraftRef.current !== draft.id) {
      visitDraftRef.current = draft.id;
      autoStartRef.current = false;
      userStoppedRef.current = false;
      setStartCheckDone(false);
      setStartBlocked(null);
      setError(null);
      setStopping(false);
      setWritingNow(0);
    }
    if (autoStartRef.current) return;

    const plan = draft.sourcePlan;
    const outline = draft.outline;
    if (!plan || !outline) return;
    autoStartRef.current = true;

    void (async () => {
      try {
        const outlineStale = isOutlineStale(outline, draft);
        const sourcesReady = sourceTextReady(draft.sourceText, draft);
        const gate = sourceGate(sourcesReady, sourceTextStale(draft.sourceText, draft));
        const sourcesStale = gate.stale;
        const sourcesUnconfirmed = gate.unconfirmed;
        const items = outline.items;
        const state = analyseWriteState(
          items,
          clauses,
          (item) => itemFingerprint(item, draft),
          writingNow,
        );
        const runningNow = isWriting(draft.id);
        const lockHeld = runningNow ? false : await draftWriteLockHeld(draft.id);
        const decision = decideWriteStart({
          counts: state.counts,
          outlineStale,
          sourcesStale,
          sourcesUnconfirmed,
          running: runningNow,
          lockHeld,
          userStopped: userStoppedRef.current,
          startedThisVisit: false,
          pendingOnlyStart: true,
        });
        setAutoDecision(decision);

        if (decision === 'start') {
          if (state.pendingIds.length > 0) await start({ onlyItemIds: state.pendingIds });
        } else if (decision === 'attach') {
          setRunning(true);
        } else if (decision === 'blocked:lock') {
          setError('This draft is already being written in another tab.');
          setStartBlocked('lock');
        }
      } catch (e) {
        setError(`Could not start writing: ${errorText(e)}`);
        setStartBlocked('error');
      } finally {
        setStartCheckDone(true);
      }
    })();
  }, [db, loading, draft?.id]);

  async function refresh() {
    if (!db || !draft) return;
    try {
      const saved = await getDraft(db, draft.id);
      if (saved) {
        setDraft(saved);
        setClauses(saved.clauses);
        setRun(saved.writeRun);
      }
      if (!isWriting(draft.id)) {
        setRunning(false);
        setStopping(false);
        setWritingNow(0);
      }
    } catch (e) {
      setError(`Could not read the draft: ${errorText(e)}`);
    }
  }

  async function start(opts: { forceItemIds?: string[]; onlyItemIds?: string[] } = {}) {
    if (!db || !draft) return;
    setBusy(true);
    setError(null);
    setStartBlocked(null);
    setAutoDecision(null);
    setRunning(true);
    setStopping(false);
    setWritingNow(0);
    try {
      const result = await startWriting(db, draft, opts);
      if (!result.ok) {
        setError(result.message ?? 'Could not start writing.');
        setStartBlocked(result.locked ? 'lock' : 'error');
      }
    } catch (e) {
      setError(`Could not start writing: ${errorText(e)}`);
      setStartBlocked('error');
    } finally {
      await refresh();
      setRunning(isWriting(draft.id));
      setBusy(false);
    }
  }

  function startBatch(ids: string[]) {
    // A user-requested batch clears the stopped state; per-section actions do not.
    userStoppedRef.current = false;
    void start({ onlyItemIds: ids });
  }

  function stop() {
    if (!draft) return;
    userStoppedRef.current = true;
    stopWriting(draft.id);
    setStopping(true);
  }

  if (loading) {
    return (
      <>
        <PageHeader eyebrow="Drafter" title="Writing your draft" />
        <p className="app-muted">Loading…</p>
      </>
    );
  }

  if (notFound || !draft) {
    return (
      <>
        <PageHeader eyebrow="Drafter" title="Draft not found" />
        <div className="app-banner app-banner--error" role="alert">
          This draft is not on this device.
        </div>
        <p>
          <Link className="app-link-button" to="/draft">
            Back to drafts
          </Link>
        </p>
      </>
    );
  }

  const plan = draft.sourcePlan;
  const outline = draft.outline;
  if (!plan || !outline) {
    return (
      <>
        <PageHeader
          eyebrow="Drafter"
          title="Confirm your structure first"
          description="I need the plan and the structure before I can write."
        />
        <p>
          <Link className="app-primary-button" to={`/draft/${draft.id}/outline`}>
            Back to structure
          </Link>
        </p>
      </>
    );
  }

  const items = outline.items;
  const currentDraft: DraftRecord = draft;
  const outlineStale = isOutlineStale(outline, draft);
  const sourcesReady = sourceTextReady(draft.sourceText, draft);
  const state = analyseWriteState(
    items,
    clauses,
    (item) => itemFingerprint(item, draft),
    writingNow,
  );
  const progress = writeProgress(state.counts);
  const complete = progress.complete;
  const estimate = estimateWriting(draft);
  const canWriteBase = !outlineStale && sourcesReady && items.length > 0;
  const canBatchWrite = canWriteBase && !complete;
  const autoReason = autoDecision
    ? writeStartReason(autoDecision, {
        userStopped: userStoppedRef.current,
        failed: state.counts.failed,
      })
    : null;
  const reasonCoveredByBanner =
    (autoDecision === 'blocked:outline' && outlineStale) ||
    (autoDecision === 'blocked:sources' && !sourcesReady) ||
    (autoDecision === 'blocked:lock' && startBlocked === 'lock');

  const attentionLabel =
    state.counts.failed === 1 ? '1 section needs attention' : `${state.counts.failed} sections need attention`;
  const staleCount = items.filter((item) => {
    const record = clauses[item.id];
    if (!record || (record.status !== 'done' && record.status !== 'verbatim')) return false;
    return record.itemFingerprint !== itemFingerprint(item, draft);
  }).length;
  const placeholders = items.reduce((sum, item) => sum + countPlaceholders(clauses[item.id]?.text ?? ''), 0);
  const assembled = assemble(draft);
  const gate = exportGate(assembled.stats);
  const hasSources = plan.bindings.some(
    (binding) => binding.useMode === 'verbatim' || binding.useMode === 'adapt',
  );

  const runLine = (() => {
    if (!run?.finishedAt) return null;
    const started = new Date(run.startedAt).getTime();
    const finished = new Date(run.finishedAt).getTime();
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;
    const duration = `Finished in ${formatRunDuration(finished - started)}`;
    return devOn ? `${duration} · ${run.retries} ${run.retries === 1 ? 'retry' : 'retries'}` : duration;
  })();

  function aliasFor(record: ClauseRecord): string {
    const binding = record.copiedFrom
      ? (currentDraft.sourcePlan?.bindings ?? []).find((entry) => entry.id === record.copiedFrom?.bindingId)
      : undefined;
    return binding ? (docs.find((doc) => doc.refDocId === binding.refDocId)?.alias ?? 'your document') : 'your document';
  }

  function rowStatus(item: OutlineItem, record: ClauseRecord | undefined): string {
    if (!record) return 'Waiting';
    if (
      record.itemFingerprint !== itemFingerprint(item, currentDraft) &&
      (record.status === 'done' || record.status === 'verbatim')
    ) {
      return 'Changed since it was written';
    }
    switch (record.status) {
      case 'writing':
        return 'Writing…';
      case 'done':
        return 'Done';
      case 'verbatim':
        return `Copied from ${aliasFor(record)}`;
      case 'failed':
        return 'Needs attention';
      default:
        return 'Waiting';
    }
  }

  const minutes = Math.max(1, Math.round(estimate.seconds / 60));

  return (
    <>
      <PageHeader
        eyebrow="Drafter"
        title="Writing your draft"
        description="Writing starts automatically for the sections that still need it. Your work is saved as it goes."
      />

      {error && (
        <div className="app-banner app-banner--error" role="alert">
          {error}
        </div>
      )}
      {outlineStale && (
        <div className="drafter-stale" role="alert">
          <p>Your plan changed after this structure was made. Update the structure before writing.</p>
          <Link className="app-link-button" to={`/draft/${draft.id}/outline`}>
            Update the structure
          </Link>
        </div>
      )}
      {!sourcesReady && (
        <div className="drafter-stale" role="alert">
          <p>Check and confirm the parts I'll use before writing.</p>
          <Link className="app-link-button" to={`/draft/${draft.id}/sources`}>
            Check the parts I'll use
          </Link>
        </div>
      )}
      {autoReason && !reasonCoveredByBanner && (
        <p className="drafter-source-note" role="status">
          {autoReason}
        </p>
      )}

      {items.length === 0 ? (
        <p className="app-muted">This structure has no sections to write.</p>
      ) : (
        <section className="drafter-outline-section">
          <div className="drafter-progress-head">
            <h2>
              {running
                ? stopping
                  ? 'Finishing the current sections…'
                  : 'Writing…'
                : complete
                  ? 'All sections written'
                  : 'Progress'}
            </h2>
            {devOn && state.counts.writing > 0 && (
              <span className="app-muted drafter-progress-now">{state.counts.writing} writing now</span>
            )}
          </div>
          <div
            className="app-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
          >
            <div className="app-progress-bar" style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="app-muted drafter-section-help">
            {progress.label}
            {state.counts.failed > 0 ? ` · ${attentionLabel}` : ''}
          </p>
          {!complete && (running || (canWriteBase && state.pendingIds.length > 0)) && (
            <p className="app-muted drafter-progress-note">
              {plural(items.length, 'section')}
              {estimate.modelItems > 0
                ? ` · about ${plural(minutes, 'minute')}`
                : ''}
              {estimate.verbatimItems > 0 ? ` · ${estimate.verbatimItems} copied directly` : ''}
            </p>
          )}

          {!startCheckDone && !running && !complete && <p className="app-muted">Starting…</p>}

          <div className="drafter-actions">
            {running && (
              <button type="button" className="app-link-button" disabled={stopping} onClick={stop}>
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
            {!running &&
              startCheckDone &&
              userStoppedRef.current &&
              canBatchWrite &&
              state.pendingIds.length > 0 && (
                <button
                  type="button"
                  className="app-primary-button"
                  disabled={busy}
                  onClick={() => startBatch(state.pendingIds)}
                >
                  {busy ? 'Starting…' : 'Resume'}
                </button>
              )}
            {!running &&
              startCheckDone &&
              startBlocked &&
              canBatchWrite &&
              state.pendingIds.length > 0 && (
                <button
                  type="button"
                  className="app-primary-button"
                  disabled={busy}
                  onClick={() => startBatch(state.pendingIds)}
                >
                  {busy ? 'Starting…' : 'Try again'}
                </button>
              )}
          </div>

          {state.counts.failed > 0 && (
            <p className="drafter-source-note">{attentionLabel}. Use Try again next to each one.</p>
          )}

          {complete && !running && (
            <>
              <p className="drafter-outline-summary">
                {placeholders === 0
                  ? 'No details are still open.'
                  : `${plural(placeholders, 'detail')} still to fill in ([●]).`}
              </p>
              {staleCount > 0 && (
                <p className="drafter-source-note">
                  {plural(staleCount, 'section')} changed since they were written.
                </p>
              )}
              {runLine && <p className="app-muted drafter-progress-note">{runLine}</p>}
              <div className="drafter-actions">
                <button
                  type="button"
                  className="app-primary-button"
                  disabled={!gate.allowed}
                  onClick={() => navigate(`/draft/${draft.id}/review`)}
                >
                  Review and download
                </button>
                {!gate.allowed && (
                  <span className="app-muted drafter-next-note">{gate.blockers[0] ?? 'The draft is not ready yet.'}</span>
                )}
              </div>
            </>
          )}
        </section>
      )}

      <ul className="drafter-write-list">
        {items.map((item, index) => {
          const record = clauses[item.id];
          const status = rowStatus(item, record);
          const stale = Boolean(
            record &&
              (record.status === 'done' || record.status === 'verbatim') &&
              record.itemFingerprint !== itemFingerprint(item, draft),
          );
          const rendered = record?.text ? renderClauseText(record.text, items) : null;
          return (
            <li key={item.id} className="drafter-write-row">
              <div className="drafter-write-head">
                <span className="drafter-write-number">
                  {record?.status === 'verbatim' ? '•' : `${index + 1}.`}
                </span>
                <span className="drafter-write-title">{item.title}</span>
                <span
                  className={`app-chip app-chip--${record?.status === 'failed' ? 'danger' : stale ? 'warn' : record?.status === 'done' || record?.status === 'verbatim' ? 'ok' : 'neutral'}`}
                >
                  {status}
                </span>
                {!running && canWriteBase && record?.status === 'failed' && (
                  <button
                    type="button"
                    className="app-link-button"
                    disabled={busy}
                    onClick={() => void start({ onlyItemIds: [item.id] })}
                  >
                    Try again
                  </button>
                )}
                {!running && canWriteBase && (record?.status === 'done' || record?.status === 'verbatim') && (
                  <button
                    type="button"
                    className="app-link-button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm('Write this section again? The current text will be replaced.')) {
                        void start({ onlyItemIds: [item.id], forceItemIds: [item.id] });
                      }
                    }}
                  >
                    Write this section again
                  </button>
                )}
              </div>

              {record?.error && <p className="drafter-source-note">{record.error}</p>}
              {record?.status === 'verbatim' && (
                <p className="app-muted drafter-section-help">
                  Names and figures in this copied text are from the source document.
                  {record.copiedFrom ? ` Copied from ${aliasFor(record)}, pages ${record.copiedFrom.pages}.` : ''}
                </p>
              )}

              {rendered && (
                <details className="drafter-write-text">
                  <summary>Read the text</summary>
                  <pre>{withPlaceholders(rendered.text)}</pre>
                  {rendered.unknownRefs.length > 0 && (
                    <p className="drafter-source-note">
                      Some cross-references could not be matched: {rendered.unknownRefs.join(', ')}.
                    </p>
                  )}
                </details>
              )}
            </li>
          );
        })}
      </ul>

      <div className="drafter-actions drafter-plan-actions">
        <div className="drafter-secondary-actions">
          <Link className="app-link-button" to={`/draft/${draft.id}/outline`}>
            Back to structure
          </Link>
          {hasSources && (
            <Link className="app-link-button" to={`/draft/${draft.id}/sources`}>
              Check the parts I'll use
            </Link>
          )}
          <Link className="app-link-button" to={`/draft/${draft.id}`}>
            Back to brief
          </Link>
        </div>
      </div>
    </>
  );
}
