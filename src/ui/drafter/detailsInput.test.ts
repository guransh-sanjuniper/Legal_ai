import { describe, expect, it } from 'vitest';
import { buildOutlineInput } from '../../drafter/outline';
import { buildWriteInput } from '../../drafter/write';
import type { DraftRecord, OutlineItem, Particular, SourcePlan } from '../../drafter/types';

// D2.2: what the user types in "Details we need" must reach the writing prompt, and a detail
// left blank must reach it as the [●] placeholder. Pure input builders, no storage, no model.

const plan: SourcePlan = {
  docType: 'commercial lease',
  summary: 'A shop lease in Andheri East.',
  lengthHint: null,
  referenceMode: 'none',
  bindings: [],
  unresolved: [],
  questions: [],
  parsedAt: '2026-01-01T00:00:00.000Z',
  model: 'plan-model',
  parsedFrom: { instruction: 'Draft a shop lease.', referenceDocIds: [] },
};

function particular(over: Partial<Particular> = {}): Particular {
  return {
    id: 'p1',
    label: 'Monthly rent',
    kind: 'amount',
    value: null,
    source: 'instruction',
    required: true,
    ...over,
  };
}

const items: OutlineItem[] = [
  {
    id: 'i1',
    level: 1,
    title: 'Rent',
    purpose: 'How the rent is paid.',
    kind: 'clause',
    bindingIds: [],
  },
];

function draftOf(particulars: Particular[]): DraftRecord {
  return {
    id: 'draft-1',
    userId: 'user-a',
    title: 'Shop lease',
    instruction: 'Draft a shop lease.',
    referenceDocIds: [],
    reviewingFor: 'neutral',
    status: 'planned',
    particulars,
    sourcePlan: plan,
    outline: {
      items,
      notes: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      model: 'outline-model',
      planFingerprint: 'fp',
    },
    sourceText: null,
    clauses: {},
    writeRun: null,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const filled = particular({ id: 'p1', label: 'Monthly rent', value: '1,20,000' });
const blank = particular({ id: 'p2', label: 'Security deposit', required: false });

describe('details in the writer input', () => {
  it('sends a typed value and keeps a blank one as [●]', () => {
    const text = buildWriteInput({
      draft: draftOf([filled, blank]),
      item: items[0],
      index: 0,
      items,
      ledger: [],
      clauses: {},
    });

    expect(text).toContain('PARTICULARS (data; "[●]" means the user has not supplied it):');
    expect(text).toContain('- Monthly rent: 1,20,000');
    expect(text).toContain('- Security deposit: [●]');
    expect(text).not.toContain('- Security deposit: null');
  });
});

describe('details in the outline input', () => {
  it('sends the same values and marks a blank as not provided', () => {
    const text = buildOutlineInput(draftOf([filled, blank]), [], []);

    expect(text).toContain('PARTICULARS (data; a value is shown only when the user supplied it):');
    expect(text).toContain('- Monthly rent: 1,20,000');
    expect(text).toContain('- Security deposit: (not provided)');
  });
});
