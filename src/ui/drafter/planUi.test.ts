import { describe, expect, it } from 'vitest';
import { buildDocAliases } from '../../drafter/plan';
import type { Particular, SourceBinding } from '../../drafter/types';
import {
  addParticular,
  answerQuestion,
  detailGroups,
  isBlank,
  missingDetails,
  particularGroup,
  referenceRows,
  setParticularValue,
  setReferenceUseMode,
} from './planUi';

const docs = buildDocAliases([
  { refDocId: 'doc-a', name: 'Andheri flat agreement.pdf', pageCount: 8, available: true },
  { refDocId: 'doc-b', name: 'Bandra shop lease.pdf', pageCount: 12, available: true },
  { refDocId: 'doc-gone', name: null, pageCount: null, available: false },
]);

function binding(over: Partial<SourceBinding> = {}): SourceBinding {
  return {
    id: 'b1',
    refDocId: 'doc-a',
    target: { type: 'whole', value: '' },
    useMode: 'adapt',
    appliesTo: '',
    phrase: '',
    ...over,
  };
}

function particular(over: Partial<Particular> = {}): Particular {
  return {
    id: 'p1',
    label: "Landlord's name",
    kind: 'party',
    value: null,
    source: 'instruction',
    required: true,
    ...over,
  };
}

describe('simple reference rows', () => {
  it('shows one row per selected document with its mode', () => {
    const rows = referenceRows(docs, [binding({ useMode: 'verbatim', appliesTo: 'indemnity' })]);
    expect(rows.map((row) => [row.alias, row.name, row.available])).toEqual([
      ['Doc A', 'Andheri flat agreement.pdf', true],
      ['Doc B', 'Bandra shop lease.pdf', true],
      ['Doc C', null, false],
    ]);
    expect(rows[0].mode).toBe('verbatim');
    expect(rows[0].editable).toBe(true);
    expect(rows[0].canClear).toBe(true);
    expect(rows[0].usedFor).toEqual(['indemnity']);
    expect(rows[1].mode).toBeNull();
    expect(rows[1].editable).toBe(true);
    expect(rows[1].canClear).toBe(false);
  });

  it('hides the dropdown when a document has several bindings', () => {
    const rows = referenceRows(docs, [
      binding({ id: 'b1' }),
      binding({ id: 'b2', target: { type: 'topic', value: 'indemnity' } }),
    ]);
    expect(rows[0].bindingCount).toBe(2);
    expect(rows[0].editable).toBe(false);
  });

  it('does not offer "general" for a single specific binding', () => {
    const rows = referenceRows(docs, [binding({ target: { type: 'topic', value: 'indemnity' } })]);
    expect(rows[0].mode).toBe('adapt');
    expect(rows[0].canClear).toBe(false);
  });
});

describe('simple use-mode dropdown', () => {
  it('creates a whole-document binding when the document has none', () => {
    const next = setReferenceUseMode([], 'doc-b', 'style');
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      refDocId: 'doc-b',
      useMode: 'style',
      target: { type: 'whole', value: '' },
      appliesTo: '',
      phrase: '',
      edited: true,
    });
  });

  it('changes only the mode of the single existing binding', () => {
    const original = binding({ target: { type: 'pages', value: '20-25' }, appliesTo: 'payment terms', phrase: 'pages 20-25' });
    const next = setReferenceUseMode([original], 'doc-a', 'verbatim');
    expect(next[0].useMode).toBe('verbatim');
    expect(next[0].target).toEqual({ type: 'pages', value: '20-25' });
    expect(next[0].appliesTo).toBe('payment terms');
    expect(next[0].phrase).toBe('pages 20-25');
    expect(next[0].edited).toBe(true);
  });

  it('leaves a document with several bindings alone', () => {
    const many = [binding({ id: 'b1' }), binding({ id: 'b2' })];
    expect(setReferenceUseMode(many, 'doc-a', 'style')).toBe(many);
  });

  it('removes a whole-document binding when "General reference" is chosen', () => {
    expect(setReferenceUseMode([binding()], 'doc-a', null)).toEqual([]);
    const specific = binding({ target: { type: 'topic', value: 'indemnity' } });
    expect(setReferenceUseMode([specific], 'doc-a', null)).toEqual([specific]);
  });
});

describe('details we need', () => {
  it('lists only required particulars without a value and the open questions', () => {
    const details = missingDetails(
      [
        particular({ id: 'p1', label: "Landlord's name" }),
        particular({ id: 'p2', label: 'Deposit', value: '50,000' }),
        particular({ id: 'p3', label: 'Optional note', required: false }),
        particular({ id: 'p4', label: 'Blank', value: '   ' }),
      ],
      ['Who is the tenant?', '  '],
    );
    expect(details).toEqual([
      { kind: 'particular', key: 'particular:p1', id: 'p1', label: "Landlord's name" },
      { kind: 'particular', key: 'particular:p4', id: 'p4', label: 'Blank' },
      { kind: 'question', key: 'question:Who is the tenant?', text: 'Who is the tenant?' },
    ]);
  });

  it('marks a typed value as the user’s own and keeps the raw text', () => {
    const next = setParticularValue([particular()], 'p1', 'Mr Sharma ');
    expect(next[0].value).toBe('Mr Sharma ');
    expect(next[0].source).toBe('user');
    expect(next[0].edited).toBe(true);
    expect(setParticularValue([particular()], 'p1', '   ')[0].value).toBeNull();
  });
});

describe('details we need', () => {
  it('puts each detail under a plain heading', () => {
    expect(particularGroup('party')).toBe('People');
    expect(particularGroup('amount')).toBe('Money');
    expect(particularGroup('date')).toBe('Dates');
    expect(particularGroup('term')).toBe('Dates');
    expect(particularGroup('property')).toBe('Property');
    expect(particularGroup('other')).toBe('Other');
  });

  it('lists only blanks, grouped by kind, required first inside a group', () => {
    const groups = detailGroups([
      particular({ id: 'p1', label: 'Notice period', kind: 'term', required: false }),
      particular({ id: 'p2', label: 'Tenant name', kind: 'party', required: false }),
      particular({ id: 'p3', label: 'Landlord name', kind: 'party', required: true }),
      particular({ id: 'p4', label: 'Rent', kind: 'amount', value: '1,20,000' }),
      particular({ id: 'p5', label: 'Deposit', kind: 'amount', required: true }),
      particular({ id: 'p6', label: 'Premises', kind: 'property', required: false }),
      particular({ id: 'p7', label: 'Blank note', kind: 'other', value: '   ' }),
    ]);

    expect(groups.map((group) => group.title)).toEqual(['People', 'Money', 'Dates', 'Property', 'Other']);
    expect(groups[0].items.map((item) => item.id)).toEqual(['p3', 'p2']);
    expect(groups[1].items.map((item) => item.id)).toEqual(['p5']);
    expect(groups[2].items.map((item) => item.id)).toEqual(['p1']);
    expect(groups[3].items.map((item) => item.id)).toEqual(['p6']);
    expect(groups[4].items.map((item) => item.id)).toEqual(['p7']);
    // A detail with a value is not asked for again.
    expect(groups.flatMap((group) => group.items).some((item) => item.id === 'p4')).toBe(false);
  });

  it('leaves out a group with nothing in it', () => {
    const groups = detailGroups([particular({ id: 'p1', kind: 'party' })]);
    expect(groups.map((group) => group.title)).toEqual(['People']);
  });

  it('treats a missing or whitespace value as blank', () => {
    expect(isBlank(particular({ value: null }))).toBe(true);
    expect(isBlank(particular({ value: '   ' }))).toBe(true);
    expect(isBlank(particular({ value: 'x' }))).toBe(false);
  });

  it('adds a detail the user typed, as their own', () => {
    const next = addParticular([particular({ id: 'p1' })], '  Parking bay  ', '  B-14 ');
    expect(next).not.toBeNull();
    const added = next![1];
    expect(added).toMatchObject({
      label: 'Parking bay',
      kind: 'other',
      value: 'B-14',
      source: 'user',
      required: false,
      edited: true,
    });

    // A label on its own keeps the placeholder, so it shows up with the other blanks.
    const blank = addParticular([], 'Parking bay', '   ');
    expect(blank![0].value).toBeNull();
    expect(isBlank(blank![0])).toBe(true);

    expect(addParticular([], '   ', 'B-14')).toBeNull();
  });
});

describe('answering a question', () => {
  it('moves the question into a particular with the user as its source', () => {
    const result = answerQuestion(
      [particular({ id: 'p1' })],
      ['Who is the tenant?', 'Who is the landlord?'],
      'Who is the tenant?',
      'Ms Iyer',
    );
    expect(result.questions).toEqual(['Who is the landlord?']);
    expect(result.particulars).toHaveLength(2);
    const added = result.particulars[1];
    expect(added).toMatchObject({
      label: 'Who is the tenant?',
      kind: 'other',
      value: 'Ms Iyer',
      source: 'user',
      required: true,
      edited: true,
    });
    expect(added.id).toBeTruthy();
  });

  it('removes only one occurrence of a repeated question', () => {
    const result = answerQuestion([], ['Same question?', 'Same question?'], 'Same question?', 'Yes');
    expect(result.questions).toEqual(['Same question?']);
    expect(result.particulars).toHaveLength(1);
  });

  it('does nothing for an empty answer', () => {
    const questions = ['Who is the tenant?'];
    const result = answerQuestion([], questions, 'Who is the tenant?', '   ');
    expect(result.questions).toBe(questions);
    expect(result.particulars).toEqual([]);
  });
});
