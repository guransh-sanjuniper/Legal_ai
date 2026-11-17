import { newPlanId, type DocAlias } from '../../drafter/plan';
import type { BindingUseMode, Particular, ParticularKind, SourceBinding } from '../../drafter/types';

// Plain-language helpers for the simple Plan view. Pure functions only: the page keeps the
// state, these decide what the simple controls show and how they change it.

export interface ReferenceRow {
  refDocId: string;
  alias: string;
  name: string | null;
  available: boolean;
  // null means "general reference": the document has no binding of its own.
  mode: BindingUseMode | null;
  bindingCount: number;
  // The dropdown is shown only when the document has no binding or exactly one.
  editable: boolean;
  // True when the single binding is a whole-document binding, so "General reference" can
  // remove it again.
  canClear: boolean;
  usedFor: string[];
}

export function referenceRows(docs: DocAlias[], bindings: SourceBinding[]): ReferenceRow[] {
  return docs.map((doc) => {
    const own = bindings.filter((binding) => binding.refDocId === doc.refDocId);
    const single = own.length === 1 ? own[0] : null;
    return {
      refDocId: doc.refDocId,
      alias: doc.alias,
      name: doc.name,
      available: doc.available,
      mode: single ? single.useMode : null,
      bindingCount: own.length,
      editable: own.length <= 1,
      canClear: Boolean(single && single.target.type === 'whole'),
      usedFor: own.map((binding) => binding.appliesTo.trim()).filter(Boolean),
    };
  });
}

// Changes how one reference is used. A document with no binding gets a whole-document binding
// with the chosen mode; a single binding keeps its target and only changes the mode; a
// document with several bindings is left alone (the simple view hides the dropdown). A null
// mode removes the whole-document binding created here.
export function setReferenceUseMode(
  bindings: SourceBinding[],
  refDocId: string,
  mode: BindingUseMode | null,
): SourceBinding[] {
  const own = bindings.filter((binding) => binding.refDocId === refDocId);
  if (own.length > 1) return bindings;

  if (mode === null) {
    if (own.length === 1 && own[0].target.type === 'whole') {
      return bindings.filter((binding) => binding.id !== own[0].id);
    }
    return bindings;
  }

  if (own.length === 0) {
    return [
      ...bindings,
      {
        id: newPlanId(),
        refDocId,
        target: { type: 'whole', value: '' },
        useMode: mode,
        appliesTo: '',
        phrase: '',
        edited: true,
      },
    ];
  }

  const existing = own[0];
  return bindings.map((binding) =>
    binding.id === existing.id ? { ...binding, useMode: mode, edited: true } : binding,
  );
}

export type MissingDetail =
  | { kind: 'particular'; key: string; id: string; label: string }
  | { kind: 'question'; key: string; text: string };

// What still needs an answer: required particulars without a value, plus the open questions.
export function missingDetails(particulars: Particular[], questions: string[]): MissingDetail[] {
  const details: MissingDetail[] = [];
  for (const item of particulars) {
    if (!item.required) continue;
    if (item.value !== null && item.value.trim() !== '') continue;
    details.push({ kind: 'particular', key: `particular:${item.id}`, id: item.id, label: item.label });
  }
  for (const question of questions) {
    const text = question.trim();
    if (!text) continue;
    details.push({ kind: 'question', key: `question:${text}`, text });
  }
  return details;
}

// ---------- Details we need (D2.2) ----------

export type DetailGroupTitle = 'People' | 'Money' | 'Dates' | 'Property' | 'Other';

const GROUP_ORDER: DetailGroupTitle[] = ['People', 'Money', 'Dates', 'Property', 'Other'];

// Plain headings for a non-lawyer. A term is a length of time, so it sits with dates.
export function particularGroup(kind: ParticularKind): DetailGroupTitle {
  switch (kind) {
    case 'party':
      return 'People';
    case 'amount':
      return 'Money';
    case 'date':
    case 'term':
      return 'Dates';
    case 'property':
      return 'Property';
    default:
      return 'Other';
  }
}

export function isBlank(particular: Particular): boolean {
  return particular.value === null || particular.value.trim() === '';
}

export interface DetailGroup {
  title: DetailGroupTitle;
  items: Particular[];
}

// Which rows the screen shows: a detail still without a value, or one the user has already
// started typing into this visit, minus the ones set aside with "Leave blank for now".
// Keeping typed rows here (rather than filtering blanks only) is what stops a row from
// vanishing on the first keystroke once it has a value.
export function visibleDetails(
  particulars: Particular[],
  keptIds: string[],
  skipped: string[],
): Particular[] {
  return particulars.filter(
    (item) =>
      (isBlank(item) || keptIds.includes(item.id)) && !skipped.includes(`particular:${item.id}`),
  );
}

// Groups the rows it is given by kind. Inside a group the required ones come first, in the order
// the model gave them. An empty group is left out.
export function detailGroups(particulars: Particular[]): DetailGroup[] {
  return GROUP_ORDER.map((title) => {
    const items = particulars.filter((item) => particularGroup(item.kind) === title);
    return {
      title,
      items: [...items.filter((item) => item.required), ...items.filter((item) => !item.required)],
    };
  }).filter((group) => group.items.length > 0);
}

// A detail the user adds themselves. The label is required; a blank value keeps it as a
// placeholder they can fill in later, so it appears in the list with the other blanks.
export function addParticular(
  particulars: Particular[],
  label: string,
  value: string,
): Particular[] | null {
  const name = label.trim();
  if (!name) return null;
  const text = value.trim();
  return [
    ...particulars,
    {
      id: newPlanId(),
      label: name,
      kind: 'other',
      value: text === '' ? null : text,
      source: 'user',
      required: false,
      edited: true,
    },
  ];
}

// Typing a value marks it as the user's own. The raw text is kept (a trailing space while
// typing is not trimmed); an empty or whitespace-only value becomes null.
export function setParticularValue(particulars: Particular[], id: string, value: string): Particular[] {
  const empty = value.trim() === '';
  return particulars.map((item) =>
    item.id === id
      ? { ...item, value: empty ? null : value, source: 'user', edited: true }
      : item,
  );
}

// An answer to one of the questions becomes a particular and the question goes away.
export function answerQuestion(
  particulars: Particular[],
  questions: string[],
  text: string,
  answer: string,
): { particulars: Particular[]; questions: string[] } {
  const value = answer.trim();
  if (!value) return { particulars, questions };
  const index = questions.findIndex((question) => question === text);
  return {
    particulars: [
      ...particulars,
      {
        id: newPlanId(),
        label: text,
        kind: 'other',
        value,
        source: 'user',
        required: true,
        edited: true,
      },
    ],
    questions: index >= 0 ? questions.filter((_, position) => position !== index) : questions,
  };
}
