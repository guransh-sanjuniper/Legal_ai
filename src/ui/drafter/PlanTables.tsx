import { useState } from 'react';
import { newPlanId, phraseInInstruction, type DocAlias } from '../../drafter/plan';
import type {
  BindingTargetType,
  BindingUseMode,
  Particular,
  ParticularKind,
  SourceBinding,
  UnresolvedRef,
} from '../../drafter/types';
import type { DetailGroup, ReferenceRow } from './planUi';

const TARGET_LABELS: Record<BindingTargetType, string> = {
  clause: 'Clause',
  topic: 'Topic',
  pages: 'Pages',
  whole: 'Whole document',
};

const USE_LABELS: Record<BindingUseMode, string> = {
  verbatim: 'Verbatim',
  adapt: 'Adapt',
  style: 'Style guide',
};

const KIND_LABELS: Record<ParticularKind, string> = {
  party: 'Party',
  amount: 'Amount',
  date: 'Date',
  property: 'Property',
  term: 'Term',
  other: 'Other',
};

export function BindingsTable({
  bindings,
  docs,
  instruction,
  disabled,
  onChange,
}: {
  bindings: SourceBinding[];
  docs: DocAlias[];
  instruction: string;
  disabled?: boolean;
  onChange: (bindings: SourceBinding[]) => void;
}) {
  const update = (id: string, patch: Partial<SourceBinding>) => {
    onChange(bindings.map((binding) => (binding.id === id ? { ...binding, ...patch, edited: true } : binding)));
  };
  const updateTarget = (binding: SourceBinding, patch: { type?: BindingTargetType; value?: string }) => {
    const type = patch.type ?? binding.target.type;
    update(binding.id, {
      target: {
        type,
        value: type === 'whole' ? '' : patch.value !== undefined ? patch.value : binding.target.value,
      },
    });
  };
  const add = () => {
    onChange([
      ...bindings,
      {
        id: newPlanId(),
        refDocId: docs[0]?.refDocId ?? '',
        target: { type: 'topic', value: '' },
        useMode: 'adapt',
        appliesTo: '',
        phrase: '',
        edited: true,
      },
    ]);
  };
  const remove = (id: string) => onChange(bindings.filter((binding) => binding.id !== id));

  return (
    <>
      {bindings.length === 0 ? (
        <p className="app-muted">No source bindings. The selected documents, if any, are a general reference.</p>
      ) : (
        <div className="app-table-wrap">
          <table className="app-table drafter-edit-table">
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Target</th>
                <th scope="col">Use</th>
                <th scope="col">Used for</th>
                <th scope="col">From the instruction</th>
                <th scope="col">
                  <span className="app-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((binding) => {
                const known = docs.some((doc) => doc.refDocId === binding.refDocId);
                const phraseMissing = binding.phrase !== '' && !phraseInInstruction(binding.phrase, instruction);
                return (
                  <tr key={binding.id}>
                    <td>
                      <select
                        value={binding.refDocId}
                        disabled={disabled}
                        aria-label="Reference document"
                        onChange={(e) => update(binding.id, { refDocId: e.target.value })}
                      >
                        {!known && <option value={binding.refDocId}>No longer selected</option>}
                        {docs.map((doc) => (
                          <option key={doc.refDocId} value={doc.refDocId}>
                            {doc.alias}
                            {doc.name ? ` — ${doc.name}` : ' — not on this device'}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div className="drafter-target">
                        <select
                          value={binding.target.type}
                          disabled={disabled}
                          aria-label="Target type"
                          onChange={(e) => updateTarget(binding, { type: e.target.value as BindingTargetType })}
                        >
                          {(Object.keys(TARGET_LABELS) as BindingTargetType[]).map((type) => (
                            <option key={type} value={type}>
                              {TARGET_LABELS[type]}
                            </option>
                          ))}
                        </select>
                        {binding.target.type !== 'whole' && (
                          <input
                            value={binding.target.value}
                            disabled={disabled}
                            aria-label="Target value"
                            placeholder={binding.target.type === 'pages' ? '20-25' : '14 or indemnity'}
                            onChange={(e) => updateTarget(binding, { value: e.target.value })}
                          />
                        )}
                      </div>
                    </td>
                    <td>
                      <select
                        value={binding.useMode}
                        disabled={disabled}
                        aria-label="Use mode"
                        onChange={(e) => update(binding.id, { useMode: e.target.value as BindingUseMode })}
                      >
                        {(Object.keys(USE_LABELS) as BindingUseMode[]).map((mode) => (
                          <option key={mode} value={mode}>
                            {USE_LABELS[mode]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        value={binding.appliesTo}
                        disabled={disabled}
                        aria-label="Used for"
                        placeholder="Which part of the new document"
                        onChange={(e) => update(binding.id, { appliesTo: e.target.value })}
                      />
                    </td>
                    <td>
                      <span className="drafter-phrase">{binding.phrase || '—'}</span>
                      {phraseMissing && <span className="drafter-phrase-warn">phrase not found in instruction</span>}
                      {binding.edited && <span className="app-muted drafter-edited">edited</span>}
                    </td>
                    <td>
                      <div className="app-row-actions">
                        <button
                          type="button"
                          className="app-link-button app-link-button--danger"
                          disabled={disabled}
                          onClick={() => remove(binding.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="app-link-button drafter-add-row" disabled={disabled} onClick={add}>
        Add binding
      </button>
    </>
  );
}

export function UnresolvedList({
  unresolved,
  disabled,
  onCreate,
  onDismiss,
}: {
  unresolved: UnresolvedRef[];
  disabled?: boolean;
  onCreate: (entry: UnresolvedRef) => void;
  onDismiss: (entry: UnresolvedRef) => void;
}) {
  if (unresolved.length === 0) {
    return <p className="app-muted">Nothing unresolved.</p>;
  }
  return (
    <ul className="drafter-unresolved-list">
      {unresolved.map((entry, index) => (
        <li key={`${entry.phrase}-${index}`} className="drafter-unresolved-row">
          <span className="drafter-unresolved-text">
            <strong>{entry.phrase || 'Unknown reference'}</strong>
            <span className="app-muted">{entry.reason || 'Could not be attached.'}</span>
          </span>
          <span className="app-row-actions">
            <button type="button" className="app-link-button" disabled={disabled} onClick={() => onCreate(entry)}>
              Create binding manually
            </button>
            <button type="button" className="app-link-button" disabled={disabled} onClick={() => onDismiss(entry)}>
              Dismiss
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ParticularsTable({
  particulars,
  disabled,
  onChange,
}: {
  particulars: Particular[];
  disabled?: boolean;
  onChange: (particulars: Particular[]) => void;
}) {
  const update = (id: string, patch: Partial<Particular>) => {
    onChange(particulars.map((item) => (item.id === id ? { ...item, ...patch, edited: true } : item)));
  };
  const add = () => {
    onChange([
      ...particulars,
      { id: newPlanId(), label: '', kind: 'other', value: null, source: 'user', required: false, edited: true },
    ]);
  };

  return (
    <>
      {particulars.length === 0 ? (
        <p className="app-muted">No particulars were found in the instruction.</p>
      ) : (
        <div className="app-table-wrap">
          <table className="app-table drafter-edit-table">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Kind</th>
                <th scope="col">Value</th>
                <th scope="col">Required</th>
                <th scope="col">
                  <span className="app-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {particulars.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input
                      value={item.label}
                      disabled={disabled}
                      aria-label="Particular label"
                      placeholder="Party name, deposit, commencement date…"
                      onChange={(e) => update(item.id, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={item.kind}
                      disabled={disabled}
                      aria-label="Particular kind"
                      onChange={(e) => update(item.id, { kind: e.target.value as ParticularKind })}
                    >
                      {(Object.keys(KIND_LABELS) as ParticularKind[]).map((kind) => (
                        <option key={kind} value={kind}>
                          {KIND_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <div className="drafter-particular-value">
                      <input
                        value={item.value ?? ''}
                        disabled={disabled}
                        aria-label="Particular value"
                        placeholder="Not in the instruction"
                        onChange={(e) =>
                          update(item.id, { value: e.target.value === '' ? null : e.target.value, source: 'user' })
                        }
                      />
                      {item.value === null ? (
                        <span className="drafter-placeholder" title="Placeholder until a value is supplied">
                          [●]
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="app-link-button"
                          disabled={disabled}
                          onClick={() => update(item.id, { value: null, source: 'user' })}
                        >
                          Leave as placeholder
                        </button>
                      )}
                    </div>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={item.required}
                      disabled={disabled}
                      aria-label="Required"
                      onChange={(e) => update(item.id, { required: e.target.checked })}
                    />
                  </td>
                  <td>
                    <div className="app-row-actions">
                      <button
                        type="button"
                        className="app-link-button app-link-button--danger"
                        disabled={disabled}
                        onClick={() => onChange(particulars.filter((candidate) => candidate.id !== item.id))}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="app-link-button drafter-add-row" disabled={disabled} onClick={add}>
        Add particular
      </button>
    </>
  );
}

export function QuestionsList({
  questions,
  disabled,
  onChange,
}: {
  questions: string[];
  disabled?: boolean;
  onChange: (questions: string[]) => void;
}) {
  return (
    <div className="drafter-questions">
      {questions.map((question, index) => (
        <div key={index} className="drafter-question-row">
          <input
            value={question}
            disabled={disabled}
            aria-label={`Question ${index + 1}`}
            onChange={(e) => onChange(questions.map((q, i) => (i === index ? e.target.value : q)))}
          />
          <button
            type="button"
            className="app-link-button app-link-button--danger"
            disabled={disabled}
            onClick={() => onChange(questions.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="app-link-button"
        disabled={disabled || questions.length >= 8}
        onClick={() => onChange([...questions, ''])}
      >
        Add question
      </button>
    </div>
  );
}

// ---------- Plain-language view ----------

export function SimpleReferenceList({
  rows,
  disabled,
  onChange,
}: {
  rows: ReferenceRow[];
  disabled?: boolean;
  onChange: (refDocId: string, mode: BindingUseMode | null) => void;
}) {
  return (
    <ul className="drafter-ref-simple-list">
      {rows.map((row) => (
        <li key={row.refDocId} className="drafter-ref-simple">
          <div className="drafter-ref-simple-head">
            <span className="drafter-ref-simple-name">
              {row.alias} — {row.name ?? 'not on this device'}
            </span>
            {row.available && row.editable && (
              <select
                value={row.mode ?? 'general'}
                disabled={disabled}
                aria-label={`How should I use ${row.alias}?`}
                onChange={(e) => {
                  const value = e.target.value;
                  onChange(row.refDocId, value === 'general' ? null : (value as BindingUseMode));
                }}
              >
                {(row.mode === null || row.canClear) && <option value="general">General reference</option>}
                <option value="verbatim">Follow its wording</option>
                <option value="adapt">Use as guidance</option>
                <option value="style">Style only</option>
              </select>
            )}
            {row.available && !row.editable && (
              <span className="app-muted drafter-ref-specific">Specific parts used (see Advanced options)</span>
            )}
          </div>
          {row.usedFor.map((text, index) => (
            <p key={`${text}-${index}`} className="app-muted drafter-ref-used">
              Used for: {text}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

// Every detail still without a value, grouped under plain headings (People, Money, Dates,
// Property, Other). Required details come first inside a group and carry a small tag.
export function DetailsNeeded({
  groups,
  disabled,
  onValue,
  onSkip,
}: {
  groups: DetailGroup[];
  disabled?: boolean;
  onValue: (particular: Particular, value: string) => void;
  onSkip: (key: string) => void;
}) {
  if (groups.length === 0) return <p className="app-muted">Nothing else needed.</p>;

  return (
    <div className="drafter-detail-groups">
      {groups.map((group) => (
        <section key={group.title} className="drafter-detail-group">
          <h3>{group.title}</h3>
          <ul className="drafter-details">
            {group.items.map((item) => (
              <li key={item.id} className="drafter-detail-row">
                <label className="app-field drafter-detail-field">
                  <span>
                    {item.label}
                    {item.required && <span className="drafter-detail-needed">needed</span>}
                  </span>
                  <input
                    value={item.value ?? ''}
                    disabled={disabled}
                    placeholder="Type the answer"
                    onChange={(e) => onValue(item, e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="app-link-button"
                  disabled={disabled}
                  onClick={() => onSkip(`particular:${item.id}`)}
                >
                  Leave blank for now
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// The open questions the model asked. An answer becomes a detail, as before.
export function QuestionRows({
  questions,
  answers,
  disabled,
  onAnswerChange,
  onAnswerCommit,
  onSkip,
}: {
  questions: string[];
  answers: Record<string, string>;
  disabled?: boolean;
  onAnswerChange: (text: string, value: string) => void;
  onAnswerCommit: (text: string, value: string) => void;
  onSkip: (key: string) => void;
}) {
  if (questions.length === 0) return null;

  return (
    <ul className="drafter-details">
      {questions.map((text) => (
        <li key={text} className="drafter-detail-row">
          <label className="app-field drafter-detail-field">
            <span>{text}</span>
            <input
              value={answers[text] ?? ''}
              disabled={disabled}
              placeholder="Type the answer"
              onChange={(e) => onAnswerChange(text, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onAnswerCommit(text, answers[text] ?? '');
                }
              }}
            />
          </label>
          <button
            type="button"
            className="app-link-button"
            disabled={disabled}
            onClick={() => onSkip(`question:${text}`)}
          >
            Leave blank for now
          </button>
        </li>
      ))}
    </ul>
  );
}

// Adds a detail the model did not think of. A blank value keeps it as a placeholder.
export function AddDetailRow({
  disabled,
  onAdd,
}: {
  disabled?: boolean;
  onAdd: (label: string, value: string) => boolean;
}) {
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [note, setNote] = useState<string | null>(null);

  function add() {
    const name = label.trim();
    if (!name) return;
    if (!onAdd(name, value)) return;
    setNote(`Added “${name}”.`);
    setLabel('');
    setValue('');
  }

  return (
    <div className="drafter-add-detail">
      <div className="drafter-add-detail-row">
        <label className="app-field drafter-detail-field">
          <span>What else do you need?</span>
          <input
            value={label}
            disabled={disabled}
            placeholder="e.g. Parking space number"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
        </label>
        <label className="app-field drafter-detail-field">
          <span>Value (optional)</span>
          <input
            value={value}
            disabled={disabled}
            placeholder="Leave empty if you don't know yet"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
        </label>
        <button
          type="button"
          className="app-link-button"
          disabled={disabled || label.trim() === ''}
          onClick={add}
        >
          Add another detail
        </button>
      </div>
      {note && <p className="app-muted drafter-add-note">{note}</p>}
    </div>
  );
}
