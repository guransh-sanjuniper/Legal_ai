import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { PageHeader } from '../app/pages/Placeholder';
import { computeReferenceMode, isPlanStale, newPlanId, type DocAlias } from '../../drafter/plan';
import { planFingerprint } from '../../drafter/outline';import { getDraft, openDrafterDb, updateDraft, type DrafterDBHandle } from '../../drafter/store';
import { syncDraftById } from '../../drafter/sync';
import type { LibraryEntry } from '../../drafter/references';
import type {
  DraftRecord,
  DraftStatus,
  Particular,
  SourceBinding,
  SourcePlan,
  UnresolvedRef,
} from '../../drafter/types';
import { loadDrafterLibrary } from './library';
import { parsePlanForDraft, planDocsForDraft } from './planRun';
import { generateOutline } from './outlineRun';
import {
  addParticular,
  answerQuestion,
  detailGroups,
  isBlank,
  referenceRows,
  setParticularValue,
  setReferenceUseMode,
} from './planUi';
import {
  AddDetailRow,
  BindingsTable,
  DetailsNeeded,
  ParticularsTable,
  QuestionRows,
  SimpleReferenceList,
  UnresolvedList,
} from './PlanTables';
import './drafter.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const advancedKey = (draftId: string) => `legal-app.draft.${draftId}.advancedOpen`;

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
    // Storage can be unavailable; the section still opens and closes for this visit.
  }
}

export function PlanPage() {
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
  const [busy, setBusy] = useState<'parse' | 'confirm' | 'outline' | null>(null);
  const [outlineFailed, setOutlineFailed] = useState(false);
  const [dropped, setDropped] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [docType, setDocType] = useState('');
  const [summary, setSummary] = useState('');
  const [lengthHint, setLengthHint] = useState('');
  const [bindings, setBindings] = useState<SourceBinding[]>([]);
  const [unresolved, setUnresolved] = useState<UnresolvedRef[]>([]);
  const [particulars, setParticulars] = useState<Particular[]>([]);
  const [questions, setQuestions] = useState<string[]>([]);

  // Simple view state only. Nothing here is stored on the draft.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<string[]>([]);
  // A detail the user has started typing into stays visible even once it has a value.
  const [keptIds, setKeptIds] = useState<string[]>([]);

  function applyPlan(plan: SourcePlan, parts: Particular[] | null) {
    setDocType(plan.docType);
    setSummary(plan.summary);
    setLengthHint(plan.lengthHint ?? '');
    setBindings(plan.bindings);
    setUnresolved(plan.unresolved);
    setParticulars(parts ?? []);
    setQuestions(plan.questions);
    setAnswers({});
    setSkipped([]);
    setKeptIds([]);
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
        if (found.sourcePlan) applyPlan(found.sourcePlan, found.particulars);
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(`Could not open the plan: ${errorText(e)}`);
        setNotFound(true);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [draftId]);

  const stale = draft ? isPlanStale(draft.sourcePlan, draft) : false;

  function currentPlan(questionsOverride?: string[]): SourcePlan | null {
    if (!draft?.sourcePlan) return null;
    const openQuestions = (questionsOverride ?? questions).map((question) => question.trim()).filter(Boolean);
    return {
      ...draft.sourcePlan,
      docType: docType.trim(),
      summary: summary.trim(),
      lengthHint: lengthHint.trim() || null,
      referenceMode: computeReferenceMode(docs, bindings),
      bindings: bindings.map((binding) => ({
        ...binding,
        appliesTo: binding.appliesTo.trim(),
        phrase: binding.phrase.trim(),
      })),
      unresolved,
      questions: openQuestions,
    };
  }

  async function save(
    nextStatus?: DraftStatus,
    overrides?: { particulars?: Particular[]; questions?: string[] },
  ): Promise<DraftRecord | null> {
    if (!db || !draft) return null;
    const plan = currentPlan(overrides?.questions);
    if (!plan) return null;

    if (nextStatus === 'planned' && stale) {
      setError('You changed your instructions after this was read. Please re-read them.');
      return null;
    }
    const incomplete = bindings.find(
      (binding) => !binding.refDocId || (binding.target.type !== 'whole' && !binding.target.value.trim()),
    );
    if (incomplete) {
      setError(
        'One of the references is missing a document or a part. Open Advanced options and fix that row, or remove it.',
      );
      return null;
    }

    const nextParticulars = overrides?.particulars ?? particulars;
    const nextQuestions = overrides?.questions ?? questions;
    setBusy('confirm');
    setError(null);
    setNotice(null);
    try {
      const saved = await updateDraft(db, draft.id, {
        sourcePlan: plan,
        particulars: nextParticulars,
        ...(nextStatus ? { status: nextStatus } : {}),
      });
      setDraft(saved);
      setParticulars(nextParticulars);
      setQuestions(nextQuestions);
      setKeptIds([]);
      void syncDraftById(supabase, db, saved.id);
      setNotice('Saved. This plan is confirmed.');
      return saved;
    } catch (e) {
      setError(`Could not save the plan: ${errorText(e)}`);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function continuePlan() {
    if (!db || !draft) return;
    if (stale) {
      setError('You changed your instructions after this was read. Please re-read them.');
      return;
    }
    let nextParticulars = particulars;
    let nextQuestions = questions;
    for (const [text, answer] of Object.entries(answers)) {
      if (!answer.trim() || !nextQuestions.includes(text)) continue;
      const result = answerQuestion(nextParticulars, nextQuestions, text, answer);
      nextParticulars = result.particulars;
      nextQuestions = result.questions;
    }
    setAnswers({});

    const nextPlan = currentPlan(nextQuestions);
    if (!nextPlan) return;

    // An outline that already matches this plan is opened, never silently regenerated.
    const fingerprint = planFingerprint({ ...draft, sourcePlan: nextPlan, particulars: nextParticulars });
    if (draft.outline && draft.outline.planFingerprint === fingerprint) {
      navigate(`/draft/${draft.id}/outline`);
      return;
    }

    const saved = await save('planned', { particulars: nextParticulars, questions: nextQuestions });
    if (!saved) return;

    setBusy('outline');
    setError(null);
    setOutlineFailed(false);
    try {
      const outcome = await generateOutline(db, saved, library);
      if (!outcome.ok) {
        setOutlineFailed(true);
        setError(outcome.message ?? 'I could not make the outline. Try again.');
        return;
      }
      navigate(`/draft/${saved.id}/outline`);
    } catch (e) {
      setOutlineFailed(true);
      setError(`I could not make the outline: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function parse() {
    if (!db || !draft) return;
    if (
      draft.sourcePlan &&
      !window.confirm('Read my instructions again? This replaces the plan and any changes you made to it.')
    ) {
      return;
    }
    setBusy('parse');
    setError(null);
    setNotice(null);
    setDropped(0);
    try {
      const outcome = await parsePlanForDraft(db, draft, library);
      if (!outcome.ok) {
        setError(outcome.message ?? 'I could not read the instructions. Try again.');
        return;
      }
      const saved = await getDraft(db, draft.id);
      if (saved) {
        setDraft(saved);
        setDocs(planDocsForDraft(saved, library));
        if (saved.sourcePlan) applyPlan(saved.sourcePlan, saved.particulars);
      }
      setDropped(outcome.dropped);
      setNotice('Read.');
    } catch (e) {
      setError(`I could not read the instructions: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  function toggleAdvanced() {
    const next = !advancedOpen;
    setAdvancedOpen(next);
    if (draftId) writeAdvanced(draftId, next);
  }

  function onParticularValue(particular: Particular, value: string) {
    setParticulars((current) => setParticularValue(current, particular.id, value));
    setKeptIds((current) =>
      current.includes(particular.id) ? current : [...current, particular.id],
    );
  }

  function onAddDetail(label: string, value: string): boolean {
    const next = addParticular(particulars, label, value);
    if (!next) return false;
    const added = next[next.length - 1];
    setParticulars(next);
    setKeptIds((current) => (current.includes(added.id) ? current : [...current, added.id]));
    return true;
  }

  function commitAnswer(text: string, answer: string) {
    if (!answer.trim() || !questions.includes(text)) return;
    const result = answerQuestion(particulars, questions, text, answer);
    setParticulars(result.particulars);
    setQuestions(result.questions);
    setAnswers((current) => {
      const next = { ...current };
      delete next[text];
      return next;
    });
  }

  if (loading) {
    return (
      <>
        <PageHeader eyebrow="Drafter" title="Plan" />
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

  if (!plan) {
    return (
      <>
        <PageHeader
          eyebrow="Drafter"
          title="I haven't read your instructions yet"
          description="Read them once and I'll show you what I understood. Nothing is drafted yet."
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
              disabled={busy === 'parse'}
              onClick={() => void parse()}
            >
              {busy === 'parse' ? 'Reading…' : 'Read my instructions'}
            </button>
            <p>
              <Link className="app-link-button" to={`/draft/${draft.id}`}>
                Back
              </Link>
            </p>
          </div>
        </section>
      </>
    );
  }

  const refRows = referenceRows(docs, bindings);

  // Blanks are listed, plus anything already typed into this visit so a row never vanishes
  // mid-keystroke. "Leave blank for now" hides a row until "Show them again".
  const visibleParticulars = particulars.filter(
    (item) => (isBlank(item) || keptIds.includes(item.id)) && !skipped.includes(`particular:${item.id}`),
  );
  const groups = detailGroups(visibleParticulars);
  const openQuestions = questions.filter((text) => !skipped.includes(`question:${text}`));

  return (
    <>
      <PageHeader
        eyebrow="Drafter"
        title="Here's what I understood"
        description="Check this is right, then continue. You can change anything below."
      />

      {error && (
        <div className="app-banner app-banner--error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="app-banner app-banner--notice">{notice}</div>}
      {dropped > 0 && (
        <p className="app-muted drafter-dropped">
          {dropped} item{dropped === 1 ? '' : 's'} could not be used and were dropped.
        </p>
      )}

      <section className="drafter-plan-section">
        <label className="app-field">
          <span>What I'll draft</span>
          <textarea
            rows={3}
            value={summary}
            disabled={busy !== null}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        <label className="app-field drafter-length">
          <span>How long should it be? (optional)</span>
          <input
            value={lengthHint}
            disabled={busy !== null}
            placeholder="e.g. 2 pages, short, detailed"
            onChange={(e) => setLengthHint(e.target.value)}
          />
        </label>
      </section>

      {docs.length > 0 && (
        <section className="drafter-plan-section">
          <h2>Reference documents</h2>
          <p className="app-muted drafter-section-help">Tell me how to use each one.</p>
          <SimpleReferenceList
            rows={refRows}
            disabled={busy !== null}
            onChange={(refDocId, nextMode) => setBindings(setReferenceUseMode(bindings, refDocId, nextMode))}
          />
        </section>
      )}

      <section className="drafter-plan-section">
        <h2>Details we need</h2>
        <p className="app-muted drafter-section-help">
          Fill in what you know. Anything left blank will appear as a highlighted [●] you can complete later.
        </p>
        <DetailsNeeded
          groups={groups}
          disabled={busy !== null}
          onValue={onParticularValue}
          onSkip={(key) => setSkipped((current) => (current.includes(key) ? current : [...current, key]))}
        />
        {openQuestions.length > 0 && (
          <div className="drafter-detail-group">
            <h3>Questions</h3>
            <QuestionRows
              questions={openQuestions}
              answers={answers}
              disabled={busy !== null}
              onAnswerChange={(text, value) => setAnswers((current) => ({ ...current, [text]: value }))}
              onAnswerCommit={commitAnswer}
              onSkip={(key) => setSkipped((current) => (current.includes(key) ? current : [...current, key]))}
            />
          </div>
        )}
        <AddDetailRow disabled={busy !== null} onAdd={onAddDetail} />
        {skipped.length > 0 && (
          <button type="button" className="app-link-button" onClick={() => setSkipped([])}>
            Show them again
          </button>
        )}
      </section>

      {unresolved.length > 0 && (
        <section className="drafter-plan-section">
          <h2>I couldn't use everything</h2>
          <ul className="drafter-notes">
            {unresolved.map((entry, index) => (
              <li key={`${entry.phrase}-${index}`} className="drafter-note">
                <span>
                  I couldn't use: <strong>{entry.phrase || 'an instruction'}</strong>
                  {entry.reason ? ` — ${entry.reason}` : ''}
                </span>
                <button
                  type="button"
                  className="app-link-button"
                  disabled={busy !== null}
                  onClick={() => setUnresolved(unresolved.filter((_, position) => position !== index))}
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {stale && (
        <div className="drafter-stale" role="alert">
          <p>You changed your instructions after this was read. Please re-read them.</p>
          <button type="button" className="app-link-button" disabled={busy !== null} onClick={() => void parse()}>
            {busy === 'parse' ? 'Reading…' : 'Re-read my instructions'}
          </button>
        </div>
      )}

      <div className="drafter-actions drafter-plan-actions">
        <div className="drafter-primary-stack">
          <button
            type="button"
            className="app-primary-button"
            disabled={busy !== null}
            onClick={() => void continuePlan()}
          >
            {busy === 'outline'
              ? 'Planning the structure…'
              : busy === 'confirm'
                ? 'Saving…'
                : outlineFailed
                  ? 'Try again'
                  : 'Looks good, continue'}
          </button>
          <span className="app-muted drafter-next-note">Next, I'll propose the structure.</span>
        </div>
        <div className="drafter-secondary-actions">
          <button type="button" className="app-link-button" disabled={busy !== null} onClick={() => void parse()}>
            {busy === 'parse' ? 'Reading…' : 'Re-read my instructions'}
          </button>
          <Link className="app-link-button" to={`/draft/${draft.id}`}>
            Back
          </Link>
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
            <section className="drafter-plan-section">
              <h2>Source bindings</h2>
              <p className="app-muted drafter-section-help">
                A binding points at a selected reference. Clause and topic targets are kept as your words; the documents
                are not read in this step.
              </p>
              <BindingsTable
                bindings={bindings}
                docs={docs}
                instruction={draft.instruction}
                disabled={busy !== null}
                onChange={setBindings}
              />
            </section>

            <section className="drafter-plan-section">
              <h2>Unresolved references</h2>
              <UnresolvedList
                unresolved={unresolved}
                disabled={busy !== null}
                onCreate={(entry) => {
                  setBindings([
                    ...bindings,
                    {
                      id: newPlanId(),
                      refDocId: docs[0]?.refDocId ?? '',
                      target: { type: 'topic', value: '' },
                      useMode: 'adapt',
                      appliesTo: '',
                      phrase: entry.phrase,
                      edited: true,
                    },
                  ]);
                  setUnresolved(unresolved.filter((candidate) => candidate !== entry));
                }}
                onDismiss={(entry) => setUnresolved(unresolved.filter((candidate) => candidate !== entry))}
              />
            </section>

            <section className="drafter-plan-section">
              <h2>Particulars</h2>
              <p className="app-muted drafter-section-help">
                Values are kept only when the instruction states them. Everything else stays a placeholder.
              </p>
              <ParticularsTable particulars={particulars} disabled={busy !== null} onChange={setParticulars} />
            </section>
          </div>
        )}
      </section>
    </>
  );
}
