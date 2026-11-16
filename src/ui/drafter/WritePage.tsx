import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../app/pages/Placeholder';
import { isOutlineStale } from '../../drafter/outline';
import { sourceTextReady } from '../../drafter/resolveRef';
import { ledgerFromClauses } from '../../drafter/ledger';
import { itemFingerprint, renderClauseText } from '../../drafter/write';
import { estimateWriting } from '../../drafter/writeEstimate';
import { getDraft, openDrafterDb, type DrafterDBHandle } from '../../drafter/store';
import type { ClauseRecord, DraftRecord, OutlineItem, WriteRun } from '../../drafter/types';
import type { DocAlias } from '../../drafter/plan';
import { loadDrafterLibrary } from './library';
import { planDocsForDraft } from './planRun';
import { isWriting, startWriting, stopWriting, subscribeWriting } from './writeRunner';
import './drafter.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
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

export function WritePage() {
  const { draftId } = useParams();

  const [db, setDb] = useState<DrafterDBHandle | null>(null);
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [docs, setDocs] = useState<DocAlias[]>([]);
  const [clauses, setClauses] = useState<Record<string, ClauseRecord>>({});
  const [run, setRun] = useState<WriteRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  useEffect(() => {
    if (!draft) return;
    return subscribeWriting(draft.id, (live) => {
      setClauses(live.clauses);
      setRun(live.run);
    });
  }, [draft?.id]);

  async function refresh() {
    if (!db || !draft) return;
    const saved = await getDraft(db, draft.id);
    if (saved) {
      setDraft(saved);
      setClauses(saved.clauses);
      setRun(saved.writeRun);
    }
  }

  async function start(forceItemIds?: string[]) {
    if (!db || !draft) return;
    setBusy(true);
    setError(null);
    setRunning(true);
    setStopping(false);
    const result = await startWriting(db, draft, forceItemIds ? { forceItemIds } : {});
    if (!result.ok) {
      setError(result.message ?? 'Could not start writing.');
      setRunning(false);
    }
    await refresh();
    setBusy(false);
  }

  function stop() {
    if (!draft) return;
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
  const estimate = estimateWriting(draft);
  const hasSources = plan.bindings.some(
    (binding) => binding.useMode === 'verbatim' || binding.useMode === 'adapt',
  );

  const doneCount = items.filter((item) => {
    const record = clauses[item.id];
    return Boolean(record && (record.status === 'done' || record.status === 'verbatim'));
  }).length;
  const progress = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;
  const staleCount = items.filter((item) => {
    const record = clauses[item.id];
    if (!record || (record.status !== 'done' && record.status !== 'verbatim')) return false;
    return record.itemFingerprint !== itemFingerprint(item, draft);
  }).length;
  const placeholders = items.reduce((sum, item) => sum + countPlaceholders(clauses[item.id]?.text ?? ''), 0);
  const allWritten = items.length > 0 && doneCount === items.length && staleCount === 0;
  const canStart = !outlineStale && sourcesReady && items.length > 0 && !running;

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

  const ledger = ledgerFromClauses(clauses, items);

  return (
    <>
      <PageHeader
        eyebrow="Drafter"
        title="Writing your draft"
        description="Each section is written separately. Your work is saved as it goes."
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

      {!running && !allWritten && (
        <section className="drafter-outline-section">
          <h2>Before I start</h2>
          <p className="drafter-outline-summary">
            {items.length} section{items.length === 1 ? '' : 's'} to write
            {estimate.verbatimItems > 0 ? ` (${estimate.verbatimItems} copied directly from your documents)` : ''}
          </p>
          <p className="app-muted drafter-section-help">
            Estimate: {estimate.modelItems} model call{estimate.modelItems === 1 ? '' : 's'}, about{' '}
            {estimate.inputTokens.toLocaleString()} tokens in and {estimate.outputTokens.toLocaleString()} out, roughly{' '}
            {Math.max(1, Math.round(estimate.seconds / 60))} minute
            {Math.max(1, Math.round(estimate.seconds / 60)) === 1 ? '' : 's'}
            {estimate.costUsd === null ? '.' : `, about $${estimate.costUsd.toFixed(2)}.`}
          </p>
          <div className="drafter-actions">
            <button type="button" className="app-primary-button" disabled={!canStart || busy} onClick={() => void start()}>
              {busy ? 'Starting…' : 'Start writing'}
            </button>
          </div>
        </section>
      )}

      {running && (
        <section className="drafter-outline-section">
          <h2>{stopping ? 'Finishing the current sections…' : 'Writing…'}</h2>
          <div className="app-progress" role="progressbar" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={doneCount}>
            <div className="app-progress-bar" style={{ width: `${progress}%` }} />
          </div>
          <p className="app-muted drafter-section-help">
            {doneCount} of {items.length} done
          </p>
          <div className="drafter-actions">
            <button type="button" className="app-link-button" disabled={stopping} onClick={stop}>
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        </section>
      )}

      {!running && !allWritten && doneCount > 0 && (
        <section className="drafter-outline-section">
          <h2>Continue</h2>
          <p className="app-muted drafter-section-help">
            {doneCount} of {items.length} sections are saved. Resume picks up where it stopped.
          </p>
          <button type="button" className="app-primary-button" disabled={!canStart || busy} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Resume'}
          </button>
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
                {!running && record?.status === 'failed' && (
                  <button type="button" className="app-link-button" onClick={() => void start([item.id])}>
                    Try again
                  </button>
                )}
                {!running && (record?.status === 'done' || record?.status === 'verbatim') && (
                  <button
                    type="button"
                    className="app-link-button"
                    onClick={() => {
                      if (window.confirm('Write this section again? The current text will be replaced.')) {
                        void start([item.id]);
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

      {allWritten && (
        <section className="drafter-outline-section">
          <h2>All sections written</h2>
          <p className="drafter-outline-summary">
            {placeholders === 0
              ? 'No details are still open.'
              : `${placeholders} detail${placeholders === 1 ? '' : 's'} still to fill in ([●]).`}
          </p>
          <div className="drafter-actions">
            <button type="button" className="app-primary-button" disabled>
              Review and download — coming next
            </button>
          </div>
        </section>
      )}

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

      <section className="drafter-advanced">
        <button
          type="button"
          className="app-link-button drafter-advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {advancedOpen ? 'Hide advanced options' : 'Advanced options'}
        </button>
        {advancedOpen && (
          <div className="drafter-advanced-body">
            <p className="app-muted drafter-plan-stamp">
              {staleCount > 0 ? `${staleCount} section(s) changed since they were written.` : 'No section is out of date.'}
            </p>
            {run && (
              <p className="app-muted drafter-plan-stamp">
                Run started {new Date(run.startedAt).toLocaleString()}
                {run.finishedAt ? `, finished ${new Date(run.finishedAt).toLocaleString()}` : ', not finished'}
                {` · ${run.calls} calls · ${run.retries} retries · ${run.rateLimitEvents} rate limits`}
                {run.rateLimitWaitMs > 0 ? ` (${formatDuration(run.rateLimitWaitMs)} waited)` : ''}
              </p>
            )}
            <ul className="drafter-write-timings">
              {items.map((item) => {
                const record = clauses[item.id];
                if (!record) return null;
                return (
                  <li key={item.id}>
                    {item.title}: {record.status}
                    {record.model ? ` · ${record.model}` : ''} · {formatDuration(record.durationMs)}
                    {record.generatedAt ? ` · ${new Date(record.generatedAt).toLocaleTimeString()}` : ''}
                  </li>
                );
              })}
            </ul>
            <p className="app-muted drafter-plan-stamp">Defined terms: {ledger.length > 0 ? ledger.map((entry) => entry.term).join(', ') : 'none'}</p>
          </div>
        )}
      </section>
    </>
  );
}
