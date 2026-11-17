import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { PageHeader } from '../app/pages/Placeholder';
import { useDeveloperMode } from '../devMode';
import { chosenCandidate, resolvePageRange, sourceTextStale } from '../../drafter/resolveRef';
import { getDraft, openDrafterDb, updateDraft, type DrafterDBHandle } from '../../drafter/store';
import { syncDraftById } from '../../drafter/sync';
import type { LibraryEntry } from '../../drafter/references';
import type { DraftRecord, SourceCandidate, SourceResolution, SourceText } from '../../drafter/types';
import type { DocAlias } from '../../drafter/plan';
import { openHarnessDb } from '../../runner/db';
import { loadDrafterLibrary } from './library';
import { planDocsForDraft } from './planRun';
import { resolveDraftSources } from './sourceRun';
import './drafter.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function statusText(resolution: SourceResolution): string {
  switch (resolution.status) {
    case 'resolved':
      return 'Found in the document.';
    case 'ambiguous':
      return 'I found more than one match. Pick the right one.';
    case 'not_found':
      return "I couldn't find it in the document.";
    case 'too_broad':
      return 'This points at the whole document. Pick the pages you need.';
  }
}

function hasUsableText(sourceText: SourceText): boolean {
  return sourceText.resolutions.every((resolution) => {
    if (resolution.skipped) return true;
    const candidate = chosenCandidate(resolution);
    return Boolean(candidate && candidate.text);
  });
}

export function SourcesPage() {
  const { draftId } = useParams();
  const navigate = useNavigate();
  const [devOn] = useDeveloperMode();

  const [db, setDb] = useState<DrafterDBHandle | null>(null);
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [docs, setDocs] = useState<DocAlias[]>([]);
  const [sourceText, setSourceText] = useState<SourceText | null>(null);
  const [resolutions, setResolutions] = useState<SourceResolution[]>([]);
  const [pagePicks, setPagePicks] = useState<Record<string, { start: string; end: string }>>({});
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState<'resolve' | 'pages' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

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

        if (found.sourceText && !sourceTextStale(found.sourceText, found) && hasUsableText(found.sourceText)) {
          setSourceText(found.sourceText);
          setResolutions(found.sourceText.resolutions);
          setLoading(false);
          return;
        }

        setBusy('resolve');
        const resolved = await resolveDraftSources(found);
        if (!alive) return;
        setSourceText(resolved);
        setResolutions(resolved.resolutions);
        const saved = await updateDraft(handle, found.id, { sourceText: resolved });
        if (alive) setDraft(saved);
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(`Could not read the documents: ${errorText(e)}`);
        setLoading(false);
      } finally {
        if (alive) setBusy(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [draftId]);

  async function resolveAgain() {
    if (!db || !draft) return;
    setBusy('resolve');
    setError(null);
    try {
      const resolved = await resolveDraftSources(draft);
      setSourceText(resolved);
      setResolutions(resolved.resolutions);
      setPagePicks({});
      const saved = await updateDraft(db, draft.id, { sourceText: resolved });
      setDraft(saved);
    } catch (e) {
      setError(`Could not read the documents: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  function choose(bindingId: string, candidateId: string) {
    setResolutions((current) =>
      current.map((resolution) =>
        resolution.bindingId === bindingId
          ? { ...resolution, chosenCandidateId: candidateId, userConfirmed: false, skipped: false }
          : resolution,
      ),
    );
  }

  function skip(bindingId: string) {
    setResolutions((current) =>
      current.map((resolution) =>
        resolution.bindingId === bindingId
          ? {
              ...resolution,
              skipped: !resolution.skipped,
              chosenCandidateId: resolution.skipped ? resolution.chosenCandidateId : undefined,
              userConfirmed: false,
            }
          : resolution,
      ),
    );
  }

  async function pickPages(resolution: SourceResolution) {
    if (!db || !draft) return;
    const binding = draft.sourcePlan?.bindings.find((entry) => entry.id === resolution.bindingId);
    if (!binding) return;
    const pick = pagePicks[resolution.bindingId] ?? { start: '', end: '' };
    const start = Number(pick.start);
    const end = Number(pick.end || pick.start);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      setError('Type the first and last page.');
      return;
    }
    setBusy('pages');
    setError(null);
    try {
      const harness = await openHarnessDb();
      const next = await resolvePageRange(harness, binding, start, end);
      setResolutions((current) =>
        current.map((entry) => (entry.bindingId === resolution.bindingId ? next : entry)),
      );
    } catch (e) {
      setError(`Could not read those pages: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function continueToWrite() {
    if (!db || !draft || !sourceText) return;
    const decided = resolutions.every((resolution) => resolution.skipped || resolution.chosenCandidateId);
    if (!decided) {
      setError('Pick or skip every source before continuing.');
      return;
    }
    setBusy('save');
    setError(null);
    try {
      const next: SourceText = {
        ...sourceText,
        resolutions: resolutions.map((resolution) => ({
          ...resolution,
          userConfirmed: !resolution.skipped && Boolean(resolution.chosenCandidateId),
        })),
      };
      const saved = await updateDraft(db, draft.id, { sourceText: next });
      setDraft(saved);
      void syncDraftById(supabase, db, saved.id);
      navigate(`/draft/${draft.id}/write`);
    } catch (e) {
      setError(`Could not save the sources: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader eyebrow="Drafter" title="Check the parts I'll use" />
        <p className="app-muted">{busy === 'resolve' ? 'Reading the documents…' : 'Loading…'}</p>
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
  if (!plan || !draft.outline) {
    return (
      <>
        <PageHeader
          eyebrow="Drafter"
          title="Confirm your plan first"
          description="I need the plan and the structure before I can read the parts you picked."
        />
        <p>
          <Link className="app-primary-button" to={`/draft/${draft.id}/plan`}>
            Back to plan
          </Link>
        </p>
      </>
    );
  }

  const decided = resolutions.every((resolution) => resolution.skipped || resolution.chosenCandidateId);
  const stale = sourceText ? sourceTextStale(sourceText, draft) : false;

  return (
    <>
      <PageHeader
        eyebrow="Drafter"
        title="Check the parts I'll use"
        description="I only use a source once you confirm it. Nothing is written on this screen."
      />

      {error && (
        <div className="app-banner app-banner--error" role="alert">
          {error}
        </div>
      )}
      {stale && (
        <div className="drafter-stale" role="alert">
          <p>Your plan or structure changed. Read the documents again before continuing.</p>
          <button type="button" className="app-link-button" disabled={busy !== null} onClick={() => void resolveAgain()}>
            {busy === 'resolve' ? 'Reading…' : 'Read the documents again'}
          </button>
        </div>
      )}

      {resolutions.length === 0 ? (
        <p className="app-muted">
          No source is bound to this structure, so there is nothing to check. You can continue to writing.
        </p>
      ) : (
        <ul className="drafter-source-list">
          {resolutions.map((resolution) => {
            const binding = plan.bindings.find((entry) => entry.id === resolution.bindingId);
            const alias = binding ? (docs.find((doc) => doc.refDocId === binding.refDocId)?.alias ?? 'Document') : 'Document';
            const chosen = chosenCandidate(resolution);
            const pick = pagePicks[resolution.bindingId] ?? { start: '', end: '' };
            return (
              <li key={resolution.bindingId} className="drafter-source-card">
                <div className="drafter-source-head">
                  <h2>
                    {alias} — {binding?.appliesTo || binding?.target.value || 'source'}
                  </h2>
                  {devOn && <span className="app-chip app-chip--neutral">{binding?.useMode ?? 'adapt'}</span>}
                </div>
                <p className="app-muted drafter-source-status">{statusText(resolution)}</p>
                {resolution.note && <p className="drafter-source-note">{resolution.note}</p>}

                {resolution.candidates.length > 0 && (
                  <div className="drafter-source-candidates">
                    {resolution.candidates.map((candidate: SourceCandidate) => (
                      <label key={candidate.id} className="drafter-source-candidate">
                        <input
                          type="radio"
                          name={`source-${resolution.bindingId}`}
                          checked={resolution.chosenCandidateId === candidate.id}
                          disabled={busy !== null || resolution.skipped}
                          onChange={() => choose(resolution.bindingId, candidate.id)}
                        />
                        <span className="drafter-source-candidate-text">
                          <strong>
                            {candidate.label} · pages {candidate.pages}
                          </strong>
                          <span className="app-muted drafter-source-preview">
                            {candidate.text.replace(/\s+/g, ' ').slice(0, 120)}
                            {candidate.text.length > 120 ? '…' : ''}
                          </span>
                          {candidate.truncated && (
                            <span className="drafter-source-note">
                              Long source: the first {candidate.text.length.toLocaleString()} characters are used.
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                )}

                {chosen && (
                  <pre className="drafter-source-text">{chosen.text}</pre>
                )}

                <div className="drafter-source-actions">
                  <span className="drafter-source-pick">
                    <span className="app-muted">Or pick pages:</span>
                    <input
                      type="number"
                      min={1}
                      value={pick.start}
                      aria-label="First page"
                      placeholder="from"
                      disabled={busy !== null}
                      onChange={(e) =>
                        setPagePicks((current) => ({
                          ...current,
                          [resolution.bindingId]: { start: e.target.value, end: current[resolution.bindingId]?.end ?? '' },
                        }))
                      }
                    />
                    <input
                      type="number"
                      min={1}
                      value={pick.end}
                      aria-label="Last page"
                      placeholder="to"
                      disabled={busy !== null}
                      onChange={(e) =>
                        setPagePicks((current) => ({
                          ...current,
                          [resolution.bindingId]: { start: current[resolution.bindingId]?.start ?? '', end: e.target.value },
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="app-link-button"
                      disabled={busy !== null || !pick.start}
                      onClick={() => void pickPages(resolution)}
                    >
                      Use these pages
                    </button>
                  </span>
                  <button
                    type="button"
                    className="app-link-button"
                    disabled={busy !== null}
                    onClick={() => skip(resolution.bindingId)}
                  >
                    {resolution.skipped ? 'Use this source again' : 'Skip this source'}
                  </button>
                </div>
                {resolution.skipped && (
                  <p className="drafter-source-note">
                    Skipped. The section will be written without this source.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="drafter-actions drafter-plan-actions">
        <div className="drafter-primary-stack">
          <button
            type="button"
            className="app-primary-button"
            disabled={busy !== null || !decided || stale}
            onClick={() => void continueToWrite()}
          >
            {busy === 'save' ? 'Saving…' : 'Looks good, continue'}
          </button>
          <span className="app-muted drafter-next-note">Next, I'll write the document section by section.</span>
        </div>
        <div className="drafter-secondary-actions">
          <Link className="app-link-button" to={`/draft/${draft.id}/outline`}>
            Back to structure
          </Link>
          <button type="button" className="app-link-button" disabled={busy !== null} onClick={() => void resolveAgain()}>
            {busy === 'resolve' ? 'Reading…' : 'Read the documents again'}
          </button>
        </div>
      </div>
    </>
  );
}
