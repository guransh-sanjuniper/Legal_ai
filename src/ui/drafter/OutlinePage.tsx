import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { PageHeader } from '../app/pages/Placeholder';
import {
  addItem,
  attachBinding,
  bindingLabel,
  childCount,
  deleteItem,
  isOutlineStale,
  numbering,
  planFingerprint,
  unusedBindings,
} from '../../drafter/outline';
import { getDraft, openDrafterDb, updateDraft, type DrafterDBHandle } from '../../drafter/store';
import { syncDraftById } from '../../drafter/sync';
import type { LibraryEntry } from '../../drafter/references';
import type { DraftRecord, Outline, OutlineItem } from '../../drafter/types';
import type { DocAlias } from '../../drafter/plan';
import { loadDrafterLibrary } from './library';
import { generateOutline, readOutlineRaw } from './outlineRun';
import { planDocsForDraft } from './planRun';
import { OutlineList } from './OutlineList';
import './drafter.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const advancedKey = (draftId: string) => `legal-app.draft.${draftId}.outlineAdvancedOpen`;

function readAdvanced(draftId: string): boolean {
  try {
    return localStorage.getItem(advancedKey(draftId)) === '1';
  } catch {
    return false;
  }
}

function writeAdvanced(draftId: string, open: boolean): void {
  try {
    localStorage.setItem(advancedKey(draftId), open ? '1' : '0');
  } catch {
    // Storage can be unavailable; the section still opens for this visit.
  }
}

function duplicateTitles(items: OutlineItem[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const item of items) {
    const title = item.title.trim();
    if (!title) continue;
    const key = `${item.level}:${title.toLowerCase()}`;
    if (seen.has(key) && !duplicates.includes(title)) duplicates.push(title);
    seen.add(key);
  }
  return duplicates;
}

export function OutlinePage() {
  const { draftId } = useParams();
  const navigate = useNavigate();

  const [db, setDb] = useState<DrafterDBHandle | null>(null);
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [docs, setDocs] = useState<DocAlias[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'generate' | 'refine' | 'save' | null>(null);
  const [dropped, setDropped] = useState(0);
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const [raw, setRaw] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [items, setItems] = useState<OutlineItem[]>([]);
  const [notes, setNotes] = useState('');
  const [refineText, setRefineText] = useState('');

  function applyOutline(outline: Outline) {
    setItems(outline.items);
    setNotes(outline.notes);
    setRefineText('');
  }

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
      setAdvancedOpen(readAdvanced(draftId));
      try {
        const entries = await loadDrafterLibrary().catch(() => []);
        if (!alive) return;
        setLibrary(entries);
        const found = await getDraft(handle, draftId);
        if (!alive) return;
        if (!found) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        setDraft(found);
        setDocs(planDocsForDraft(found, entries));
        if (found.outline) applyOutline(found.outline);
        setRaw(readOutlineRaw(draftId));
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(`Could not open the outline: ${errorText(e)}`);
        setNotFound(true);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [draftId]);

  async function generate(opts: { feedback?: string; previous?: Outline | null } = {}) {
    if (!db || !draft) return;
    setBusy(opts.feedback ? 'refine' : 'generate');
    setError(null);
    setNotice(null);
    try {
      const outcome = await generateOutline(db, draft, library, opts);
      setRaw(outcome.raw);
      if (!outcome.ok) {
        setError(outcome.message ?? 'I could not make the outline. Try again.');
        return;
      }
      const saved = await getDraft(db, draft.id);
      if (saved) {
        setDraft(saved);
        if (saved.outline) applyOutline(saved.outline);
      }
      setDropped(outcome.dropped);
      setDuplicates(outcome.duplicates);
      setNotice(opts.feedback ? 'Updated.' : 'Here is the structure.');
    } catch (e) {
      setError(`I could not make the outline: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function refine() {
    if (!draft?.outline) return;
    const text = refineText.trim();
    if (!text) {
      setError('Write what you want changed first.');
      return;
    }
    if (
      !window.confirm(
        'Update the outline with these instructions? Your manual changes are sent to the model, which may reword them.',
      )
    ) {
      return;
    }
    await generate({ feedback: text, previous: { ...draft.outline, items, notes } });
  }

  async function startAgain() {
    if (!draft) return;
    if (!window.confirm('Start the outline again? Your changes to the structure will be lost.')) return;
    await generate();
  }

  async function confirmOutline() {
    if (!db || !draft?.outline) return;
    if (isOutlineStale(draft.outline, draft)) {
      setError('Your plan changed after this outline was made. Please update the outline.');
      return;
    }
    if (items.some((item) => !item.title.trim())) {
      setError('Every section needs a title.');
      return;
    }
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const outline: Outline = {
        items: items.map((item) => ({ ...item, title: item.title.trim(), purpose: item.purpose.trim() })),
        notes: notes.trim(),
        createdAt: draft.outline.createdAt,
        model: draft.outline.model,
        planFingerprint: planFingerprint(draft),
        ...(draft.outline.feedback ? { feedback: draft.outline.feedback } : {}),
      };
      const saved = await updateDraft(db, draft.id, { outline, status: 'outlined' });
      setDraft(saved);
      setNotice('Saved. The structure is confirmed.');
      void syncDraftById(supabase, db, saved.id);
      const needsSources = (draft.sourcePlan?.bindings ?? []).some(
        (binding) => binding.useMode === 'verbatim' || binding.useMode === 'adapt',
      );
      navigate(`/draft/${draft.id}/${needsSources ? 'sources' : 'write'}`);
    } catch (e) {
      setError(`Could not save the outline: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  function handleDelete(item: OutlineItem) {
    const children = childCount(items, item.id);
    if (
      children > 0 &&
      !window.confirm(
        `Delete this section and its ${children} sub-section${children === 1 ? '' : 's'}?`,
      )
    ) {
      return;
    }
    setItems(deleteItem(items, item.id).items);
  }

  function toggleAdvanced() {
    const next = !advancedOpen;
    setAdvancedOpen(next);
    if (draftId) writeAdvanced(draftId, next);
  }

  if (loading) {
    return (
      <>
        <PageHeader eyebrow="Drafter" title="Structure" />
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
  const stale = isOutlineStale(outline, draft);

  if (!plan) {
    return (
      <>
        <PageHeader
          eyebrow="Drafter"
          title="Confirm your plan first"
          description="I need the plan before I can propose a structure."
        />
        <p>
          <Link className="app-primary-button" to={`/draft/${draft.id}/plan`}>
            Back to plan
          </Link>
        </p>
      </>
    );
  }

  if (!outline) {
    return (
      <>
        <PageHeader
          eyebrow="Drafter"
          title="I haven't proposed a structure yet"
          description="Nothing is written until you confirm the structure."
        />
        {error && (
          <div className="app-banner app-banner--error" role="alert">
            {error}
          </div>
        )}
        <section className="app-empty-card">
          <h2>Ready when you are</h2>
          <div className="app-empty-body">
            <button
              type="button"
              className="app-primary-button"
              disabled={busy === 'generate'}
              onClick={() => void generate()}
            >
              {busy === 'generate' ? 'Planning the structure…' : 'Make the outline'}
            </button>
            <p>
              <Link className="app-link-button" to={`/draft/${draft.id}/plan`}>
                Back to plan
              </Link>
            </p>
          </div>
        </section>
        {raw && (
          <details className="drafter-raw">
            <summary>Model reply (debug)</summary>
            <pre>{raw}</pre>
          </details>
        )}
      </>
    );
  }

  const sections = items.filter((item) => item.level === 1).length;
  const subSections = items.length - sections;
  const lengthText = plan.lengthHint ? ` · ${plan.lengthHint}` : '';
  const unused = unusedBindings({ items }, plan);
  const repeated = duplicateTitles(items);
  const labels = numbering(items);

  return (
    <>
      <PageHeader
        eyebrow="Drafter"
        title="Here's the structure I propose"
        description="Rearrange, rename or remove anything. Nothing is written until you continue."
      />

      {error && (
        <div className="app-banner app-banner--error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="app-banner app-banner--notice">{notice}</div>}

      <p className="drafter-outline-summary">
        {sections} section{sections === 1 ? '' : 's'}
        {subSections > 0 ? `, ${subSections} sub-section${subSections === 1 ? '' : 's'}` : ''}
        {lengthText}
      </p>

      {stale && (
        <div className="drafter-stale" role="alert">
          <p>Your plan changed after this outline was made. Please update the outline.</p>
          <button type="button" className="app-link-button" disabled={busy !== null} onClick={() => void generate()}>
            {busy === 'generate' ? 'Updating…' : 'Update the outline'}
          </button>
        </div>
      )}

      <OutlineList
        items={items}
        bindings={plan.bindings}
        docs={docs}
        disabled={busy !== null}
        onItems={setItems}
        onDelete={handleDelete}
        onAdd={(afterId) => setItems(addItem(items, afterId))}
      />
      <button
        type="button"
        className="app-link-button drafter-add-section"
        disabled={busy !== null}
        onClick={() => setItems(addItem(items, null))}
      >
        + Add a section
      </button>

      {unused.length > 0 && (
        <section className="drafter-outline-section">
          <h2>Not used yet</h2>
          <ul className="drafter-notes">
            {unused.map((binding) => (
              <li key={binding.id} className="drafter-note">
                <span>
                  <strong>{bindingLabel(binding, docs)}</strong> isn't used in any section yet.
                </span>
                <select
                  className="drafter-uses-select"
                  value=""
                  disabled={busy !== null}
                  aria-label={`Attach ${bindingLabel(binding, docs)} to a section`}
                  onChange={(e) => {
                    if (e.target.value) setItems(attachBinding(items, e.target.value, binding.id));
                  }}
                >
                  <option value="">Attach to…</option>
                  {items.map((item, index) => (
                    <option key={item.id} value={item.id}>
                      {labels[index] ? `${labels[index]} ` : ''}
                      {item.title || 'Untitled section'}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      )}

      {repeated.length > 0 && (
        <p className="app-muted drafter-outline-hint">
          The same title appears more than once: {repeated.map((title) => `“${title}”`).join(', ')}.
        </p>
      )}

      <section className="drafter-outline-section">
        <h2>Change it with instructions</h2>
        <p className="app-muted drafter-section-help">
          For example: make it shorter, add a force majeure clause, move payment before term.
        </p>
        <div className="drafter-refine">
          <textarea
            rows={3}
            value={refineText}
            disabled={busy !== null}
            placeholder="Tell me what to change"
            onChange={(e) => setRefineText(e.target.value)}
          />
          <button
            type="button"
            className="app-link-button"
            disabled={busy !== null || !refineText.trim()}
            onClick={() => void refine()}
          >
            {busy === 'refine' ? 'Updating…' : 'Update outline'}
          </button>
        </div>
      </section>

      <div className="drafter-actions drafter-plan-actions">
        <div className="drafter-primary-stack">
          <button
            type="button"
            className="app-primary-button"
            disabled={busy !== null}
            onClick={() => void confirmOutline()}
          >
            {busy === 'save'
              ? 'Saving…'
              : draft.status === 'outlined'
                ? 'Continue'
                : 'Looks good, continue'}
          </button>
          <span className="app-muted drafter-next-note">Next, I'll check the parts I'll use.</span>
        </div>
        <div className="drafter-secondary-actions">
          <Link className="app-link-button" to={`/draft/${draft.id}/plan`}>
            Back to plan
          </Link>
          <button type="button" className="app-link-button" disabled={busy !== null} onClick={() => void startAgain()}>
            Start the outline again
          </button>
        </div>
      </div>

      <section className="drafter-advanced">
        <button
          type="button"
          className="app-link-button drafter-advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={toggleAdvanced}
        >
          {advancedOpen ? 'Hide advanced options' : 'Advanced options'}
        </button>
        {advancedOpen && (
          <div className="drafter-advanced-body">
            <p className="app-muted drafter-plan-stamp">
              Made {new Date(outline.createdAt).toLocaleString()} · {outline.model}
            </p>
            {dropped > 0 && (
              <p className="app-muted drafter-dropped">
                {dropped} item{dropped === 1 ? '' : 's'} could not be used and were dropped.
              </p>
            )}
            {duplicates.length > 0 && (
              <p className="app-muted drafter-dropped">Repeated titles: {duplicates.join(', ')}.</p>
            )}
            <p className="app-muted drafter-plan-stamp">Plan fingerprint: {outline.planFingerprint}</p>
            {raw && (
              <details className="drafter-raw" open={Boolean(error)}>
                <summary>Model reply (debug)</summary>
                <pre>{raw}</pre>
              </details>
            )}
            <p className="app-muted drafter-plan-stamp">Notes: {notes || '—'}</p>
          </div>
        )}
      </section>
    </>
  );
}
