import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { PageHeader } from '../app/pages/Placeholder';
import { draftStatusLabel } from '../../drafter/brief';
import {
  computeReferenceMode,
  isPlanStale,
  newPlanId,
  type DocAlias,
} from '../../drafter/plan';
import { getDraft, openDrafterDb, updateDraft, type DrafterDBHandle } from '../../drafter/store';
import { syncDraftById } from '../../drafter/sync';
import type { LibraryEntry } from '../../drafter/references';
import type {
  DraftRecord,
  DraftStatus,
  Particular,
  ReferenceMode,
  SourceBinding,
  SourcePlan,
  UnresolvedRef,
} from '../../drafter/types';
import { loadDrafterLibrary } from './library';
import { parsePlanForDraft, planDocsForDraft, readPlanRaw } from './planRun';
import { BindingsTable, ParticularsTable, QuestionsList, UnresolvedList } from './PlanTables';
import './drafter.css';

const MODE_LABEL: Record<ReferenceMode, string> = {
  none: 'No references',
  general: 'General reference',
  specific: 'Specific bindings',
  mixed: 'Mixed',
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function statusTone(status: DraftStatus): 'ok' | 'warn' | 'neutral' | 'danger' {
  if (status === 'done') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'generating') return 'warn';
  return 'neutral';
}

export function PlanPage() {
  const { draftId } = useParams();

  const [db, setDb] = useState<DrafterDBHandle | null>(null);
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [docs, setDocs] = useState<DocAlias[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'parse' | 'save' | 'confirm' | null>(null);
  const [dropped, setDropped] = useState(0);
  const [raw, setRaw] = useState<string | null>(null);

  const [docType, setDocType] = useState('');
  const [summary, setSummary] = useState('');
  const [lengthHint, setLengthHint] = useState('');
  const [bindings, setBindings] = useState<SourceBinding[]>([]);
  const [unresolved, setUnresolved] = useState<UnresolvedRef[]>([]);
  const [particulars, setParticulars] = useState<Particular[]>([]);
  const [questions, setQuestions] = useState<string[]>([]);

  function applyPlan(plan: SourcePlan, parts: Particular[] | null) {
    setDocType(plan.docType);
    setSummary(plan.summary);
    setLengthHint(plan.lengthHint ?? '');
    setBindings(plan.bindings);
    setUnresolved(plan.unresolved);
    setParticulars(parts ?? []);
    setQuestions(plan.questions);
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
        setRaw(readPlanRaw(draftId));
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
  const mode = computeReferenceMode(docs, bindings);
  const needed = particulars.filter((item) => item.required && item.value === null);
  const openQuestions = questions.map((question) => question.trim()).filter(Boolean);

  function currentPlan(): SourcePlan | null {
    if (!draft?.sourcePlan) return null;
    return {
      ...draft.sourcePlan,
      docType: docType.trim(),
      summary: summary.trim(),
      lengthHint: lengthHint.trim() || null,
      referenceMode: mode,
      bindings: bindings.map((binding) => ({
        ...binding,
        appliesTo: binding.appliesTo.trim(),
        phrase: binding.phrase.trim(),
      })),
      unresolved,
      questions: openQuestions,
    };
  }

  async function save(nextStatus?: DraftStatus) {
    if (!db || !draft) return;
    const plan = currentPlan();
    if (!plan) return;
    const incomplete = bindings.find(
      (binding) => !binding.refDocId || (binding.target.type !== 'whole' && !binding.target.value.trim()),
    );
    if (incomplete) {
      setError('Every binding needs a document and a target. Fill in the missing value or delete the row.');
      return;
    }
    setBusy(nextStatus === 'planned' ? 'confirm' : 'save');
    setError(null);
    setNotice(null);
    try {
      const saved = await updateDraft(db, draft.id, {
        sourcePlan: plan,
        particulars,
        ...(nextStatus ? { status: nextStatus } : {}),
      });
      setDraft(saved);
      void syncDraftById(supabase, db, saved.id);
      setNotice(nextStatus === 'planned' ? 'Plan confirmed.' : 'Plan saved.');
    } catch (e) {
      setError(`Could not save the plan: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function parse() {
    if (!db || !draft) return;
    if (draft.sourcePlan && !window.confirm('Re-run parsing? This replaces the plan and discards edits.')) return;
    setBusy('parse');
    setError(null);
    setNotice(null);
    setDropped(0);
    try {
      const outcome = await parsePlanForDraft(db, draft, library);
      setRaw(outcome.raw);
      if (!outcome.ok) {
        setError(outcome.message ?? 'Parsing failed. Retry.');
        return;
      }
      const saved = await getDraft(db, draft.id);
      if (saved) {
        setDraft(saved);
        setDocs(planDocsForDraft(saved, library));
        if (saved.sourcePlan) applyPlan(saved.sourcePlan, saved.particulars);
      }
      setDropped(outcome.dropped);
      setNotice(
        outcome.dropped > 0
          ? `${outcome.dropped} item${outcome.dropped === 1 ? '' : 's'} could not be verified and were dropped.`
          : 'Plan parsed.',
      );
    } catch (e) {
      setError(`Could not parse the instruction: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  function createBinding(entry: UnresolvedRef) {
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
  }

  if (loading) {
    return (
      <>
        <PageHeader eyebrow="Drafter" title="Plan" />
        <p className="app-muted">Loading plan…</p>
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
  const backToBrief = (
    <Link className="app-link-button" to={`/draft/${draft.id}`}>
      Back to Brief
    </Link>
  );

  if (!plan) {
    return (
      <>
        <PageHeader
          eyebrow="Drafter"
          title="Plan"
          description="The plan is parsed from the saved Brief. Nothing is generated in this step."
          actions={backToBrief}
        />
        {error && (
          <div className="app-banner app-banner--error" role="alert">
            {error}
          </div>
        )}
        <section className="app-empty-card">
          <h2>No plan yet</h2>
          <div className="app-empty-body">
            <p>Parsing turns the instruction into source bindings and the particulars to confirm.</p>
            <button type="button" className="app-primary-button" disabled={busy === 'parse'} onClick={() => void parse()}>
              {busy === 'parse' ? 'Parsing…' : 'Parse the instruction'}
            </button>
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

  return (
    <>
      <PageHeader
        eyebrow="Drafter"
        title="Plan"
        description="Check and edit the plan the Drafter will work from. Confirming it is the only thing that moves the draft on."
        actions={
          <>
            {backToBrief}
            <Link className="app-link-button" to="/draft">
              Back to drafts
            </Link>
          </>
        }
      />

      <div className="drafter-plan-meta">
        <span className={`app-chip app-chip--${statusTone(draft.status)}`}>{draftStatusLabel(draft.status)}</span>
        <span className="app-chip app-chip--neutral" title="Computed from the selected references and the bindings">
          {MODE_LABEL[mode]}
        </span>
        <span className="app-muted drafter-plan-stamp">
          Parsed {new Date(plan.parsedAt).toLocaleString()} · {plan.model}
        </span>
      </div>

      {stale && (
        <div className="app-banner app-banner--error" role="alert">
          The Brief changed since this plan was parsed. Re-run parsing before confirming.
        </div>
      )}
      {error && (
        <div className="app-banner app-banner--error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="app-banner app-banner--notice">{notice}</div>}

      <section className="drafter-plan-section">
        <h2>Summary</h2>
        <div className="drafter-plan-grid">
          <label className="app-field">
            <span>Document type (the instruction's own words)</span>
            <input value={docType} disabled={busy !== null} onChange={(e) => setDocType(e.target.value)} />
          </label>
          <label className="app-field">
            <span>Length hint (only if the instruction stated one)</span>
            <input
              value={lengthHint}
              disabled={busy !== null}
              placeholder="e.g. 2 pages, short, detailed"
              onChange={(e) => setLengthHint(e.target.value)}
            />
          </label>
        </div>
        <label className="app-field">
          <span>Summary</span>
          <textarea
            rows={3}
            value={summary}
            disabled={busy !== null}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
      </section>

      <section className="drafter-plan-section">
        <h2>Source bindings</h2>
        <p className="app-muted drafter-section-help">
          A binding points at a selected reference. Clause and topic targets are kept as your words; the documents are not
          read in this step.
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
          onCreate={createBinding}
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

      <section className="drafter-plan-section">
        <h2>Needed to complete the draft</h2>
        <p className="app-muted drafter-section-help">Informational. Missing items do not block confirming the plan.</p>
        {needed.length === 0 && openQuestions.length === 0 ? (
          <p className="app-muted">Nothing outstanding.</p>
        ) : (
          <ul className="drafter-needed">
            {needed.map((item) => (
              <li key={item.id}>
                <strong>{item.label}</strong> <span className="app-muted">({item.kind}) is not in the instruction.</span>
              </li>
            ))}
          </ul>
        )}
        <QuestionsList questions={questions} disabled={busy !== null} onChange={setQuestions} />
      </section>

      <div className="drafter-actions drafter-plan-actions">
        <button
          type="button"
          className="app-link-button"
          disabled={busy !== null}
          onClick={() => void parse()}
        >
          {busy === 'parse' ? 'Parsing…' : 'Re-run parsing'}
        </button>
        <button
          type="button"
          className="app-link-button"
          disabled={busy !== null}
          onClick={() => void save()}
        >
          {busy === 'save' ? 'Saving…' : 'Save plan'}
        </button>
        <button
          type="button"
          className="app-primary-button"
          disabled={busy !== null || stale}
          onClick={() => void save('planned')}
        >
          {busy === 'confirm' ? 'Confirming…' : 'Confirm plan'}
        </button>
        <span className="drafter-next" title="Coming in D3">
          <button type="button" className="app-primary-button" disabled>
            Next: outline
          </button>
        </span>
      </div>

      {dropped > 0 && (
        <p className="app-muted drafter-dropped">{dropped} item{dropped === 1 ? '' : 's'} could not be verified and were dropped.</p>
      )}
      {raw && (
        <details className="drafter-raw" open={Boolean(error) || dropped > 0}>
          <summary>Model reply (debug)</summary>
          <pre>{raw}</pre>
        </details>
      )}
    </>
  );
}
