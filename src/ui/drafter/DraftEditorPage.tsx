import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ReviewingFor } from '../../analysis/types';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../app/AuthProvider';
import { PageHeader } from '../app/pages/Placeholder';
import { deriveTitle } from '../../drafter/brief';
import { createDraft, getDraft, openDrafterDb, updateDraft, type DrafterDBHandle } from '../../drafter/store';
import { isPlanStale } from '../../drafter/plan';
import { syncDraftById } from '../../drafter/sync';
import type { LibraryEntry } from '../../drafter/references';
import type { DraftRecord } from '../../drafter/types';
import { loadDrafterLibrary } from './library';
import { parsePlanForDraft } from './planRun';
import { decideBriefContinue } from './briefContinue';
import { ReferencePicker } from './ReferencePicker';
import './drafter.css';

const INSTRUCTION_MAX = 20000;
const TITLE_MAX = 200;

const INSTRUCTION_PLACEHOLDER = `Describe the document you need. For example:

Draft a residential leave and licence agreement for a flat in Pune under Maharashtra law, with a refundable security deposit and 60 days' notice. (No references.)

Use the two selected agreements as reference: draft a commercial lease in the same style, keeping their clause order and defined terms.

Take the indemnity clause from Doc A and the payment terms from Doc B, then draft the remaining clauses from the terms in this instruction.`;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function DraftEditorPage() {
  const { draftId } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const userId = session?.user.id ?? '';

  const [db, setDb] = useState<DrafterDBHandle | null>(null);
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseFailed, setParseFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  // An untouched title field means "derive from the instruction", so a rewrite of the
  // instruction also updates the title in the list.
  const [titleEdited, setTitleEdited] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [reviewingFor, setReviewingFor] = useState<ReviewingFor>('neutral');
  const [referenceIds, setReferenceIds] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      let draftsDb: DrafterDBHandle;
      try {
        draftsDb = await openDrafterDb();
      } catch (e) {
        if (!alive) return;
        setError(`Could not open drafts on this device: ${errorText(e)}`);
        setLoading(false);
        setNotFound(Boolean(draftId));
        return;
      }
      if (!alive) return;
      setDb(draftsDb);

      // The reference list reuses the library's own Ready check; a failure here only removes
      // the picker, it never blocks the brief.
      try {
        const entries = await loadDrafterLibrary();
        if (alive) setLibrary(entries);
      } catch {
        if (alive) setLibrary([]);
      }

      if (!draftId) {
        if (alive) setLoading(false);
        return;
      }

      try {
        const found = await getDraft(draftsDb, draftId);
        if (!alive) return;
        if (!found) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        setDraft(found);
        setTitle(found.title);
        // A title that differs from the derived one was typed by the user and must survive
        // later saves (the store only re-derives a blank title).
        setTitleEdited(found.title !== deriveTitle(found.instruction));
        setInstruction(found.instruction);
        setReviewingFor(found.reviewingFor);
        setReferenceIds(found.referenceDocIds);
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(`Could not open the draft: ${errorText(e)}`);
        setLoading(false);
        setNotFound(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [draftId]);

  const refsChanged = referenceIds.join('\u0000') !== (draft?.referenceDocIds ?? []).join('\u0000');
  const dirty = draft
    ? title !== draft.title ||
      instruction !== draft.instruction ||
      reviewingFor !== draft.reviewingFor ||
      refsChanged
    : instruction.trim().length > 0;
  const hasPlan = Boolean(draft?.sourcePlan);
  const savedPlanStale = draft ? isPlanStale(draft.sourcePlan, draft) : false;
  const formPlanStale = draft
    ? isPlanStale(draft.sourcePlan, { instruction: instruction.trim(), referenceDocIds: referenceIds })
    : false;
  const busy = saving || parsing;

  async function persistBrief(): Promise<DraftRecord | null> {
    if (!db) return null;
    const text = instruction.trim();
    if (!text) {
      setError('Write what you need drafted first.');
      return null;
    }
    setSaving(true);
    setError(null);
    try {
      // Only an edited title is sent; otherwise the store derives it from the instruction.
      const nextTitle = titleEdited ? title : '';
      const saved = draft
        ? await updateDraft(db, draft.id, {
            title: nextTitle,
            instruction: text,
            reviewingFor,
            referenceDocIds: referenceIds,
          })
        : await createDraft(db, {
            userId,
            title: nextTitle,
            instruction: text,
            reviewingFor,
            referenceDocIds: referenceIds,
          });
      setDraft(saved);
      setTitle(saved.title);
      setTitleEdited(saved.title !== deriveTitle(saved.instruction));
      setInstruction(saved.instruction);
      // Best effort: the draft is already durable on this device.
      void syncDraftById(supabase, db, saved.id);
      return saved;
    } catch (e) {
      setError(`Could not save the draft: ${errorText(e)}`);
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndClose() {
    const saved = await persistBrief();
    if (saved) navigate('/draft');
  }

  async function continueFlow() {
    if (!db) return;
    const text = instruction.trim();
    const action = decideBriefContinue({
      instructionTrimmed: text,
      draftExists: Boolean(draft),
      dirty,
      planFreshForForm: draft?.sourcePlan
        ? !isPlanStale(draft.sourcePlan, { instruction: text, referenceDocIds: referenceIds })
        : false,
    });

    if (action === 'blocked:instruction') {
      setParseFailed(false);
      setError('Write what you need drafted first.');
      return;
    }

    setError(null);
    setParseFailed(false);

    let saved = draft;
    if (action === 'create-and-read' || action === 'save-and-read' || action === 'save-and-navigate') {
      saved = await persistBrief();
      if (!saved) return;
    }

    if (action === 'navigate' || action === 'save-and-navigate') {
      if (saved) navigate(`/draft/${saved.id}/plan`);
      return;
    }

    if (!saved) return;
    setParsing(true);
    try {
      const outcome = await parsePlanForDraft(db, saved, library);
      if (!outcome.ok) {
        setParseFailed(true);
        setError(outcome.message ?? 'I could not read the instructions. Try again.');
        return;
      }
      navigate(`/draft/${saved.id}/plan`);
    } catch (e) {
      setParseFailed(true);
      setError(`I could not read the instructions: ${errorText(e)}`);
    } finally {
      setParsing(false);
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader eyebrow="Drafter" title="Draft" />
        <p className="app-muted">Loading draft…</p>
      </>
    );
  }

  if (notFound) {
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

  return (
    <>
      <PageHeader
        eyebrow="Drafter"
        title={draft ? 'Brief' : 'New draft'}
        description="Write what you need drafted. Continue saves it and reads it before showing the plan."
        helpPageId="drafter-brief"
        actions={
          <Link className="app-link-button" to="/draft">
            Back to drafts
          </Link>
        }
      />

      {error && (
        <div className="app-banner app-banner--error" role="alert">
          {error}
        </div>
      )}
      {hasPlan && (savedPlanStale || formPlanStale) && (
        <div className="app-banner app-banner--error" role="alert">
          You changed your instructions. Continue will read them again before opening the plan.
        </div>
      )}

      <form
        className="app-form drafter-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void continueFlow();
        }}
      >
        <label className="app-field">
          <span>Title (optional)</span>
          <input
            value={title}
            maxLength={TITLE_MAX}
            disabled={busy}
            placeholder="Taken from the instruction when left blank"
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleEdited(true);
            }}
          />
        </label>

        <label className="app-field app-field--wide">
          <span>What do you need drafted?</span>
          <textarea
            className="drafter-instruction"
            rows={12}
            maxLength={INSTRUCTION_MAX}
            value={instruction}
            disabled={busy}
            placeholder={INSTRUCTION_PLACEHOLDER}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </label>

        <ReferencePicker library={library} selectedIds={referenceIds} onChange={setReferenceIds} disabled={busy} />

        <label className="app-field drafter-reviewing">
          <span>Which side are you drafting for?</span>
          <select
            value={reviewingFor}
            disabled={busy}
            onChange={(e) => setReviewingFor(e.target.value as ReviewingFor)}
          >
            <option value="neutral">Neutral</option>
            <option value="licensor">Landlord (licensor)</option>
            <option value="licensee">Tenant (licensee)</option>
          </select>
        </label>

        <div className="drafter-actions">
          <button type="submit" className="app-primary-button" disabled={!db || busy}>
            {parsing ? 'Reading…' : saving ? 'Saving…' : parseFailed ? 'Try again' : 'Continue'}
          </button>
          <button
            type="button"
            className="app-link-button"
            disabled={!db || busy}
            onClick={() => void saveAndClose()}
          >
            Save and close
          </button>
        </div>
      </form>
    </>
  );
}
