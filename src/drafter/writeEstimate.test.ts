import { describe, expect, it } from 'vitest';
import { estimateWriting } from './writeEstimate';
import type { DraftRecord, OutlineItem, SourceBinding, SourcePlan, SourceText } from './types';

const bindings: SourceBinding[] = [
  {
    id: 'bind-v',
    refDocId: 'doc-a',
    target: { type: 'clause', value: '14' },
    useMode: 'verbatim',
    appliesTo: 'indemnity',
    phrase: '',
  },
  {
    id: 'bind-a',
    refDocId: 'doc-b',
    target: { type: 'pages', value: '2-3' },
    useMode: 'adapt',
    appliesTo: 'payment',
    phrase: '',
  },
];

const plan: SourcePlan = {
  docType: 'lease',
  summary: 'A lease.',
  lengthHint: null,
  referenceMode: 'specific',
  bindings,
  unresolved: [],
  questions: [],
  parsedAt: '2026-01-01T00:00:00.000Z',
  model: 'plan-model',
  parsedFrom: { instruction: 'Draft a lease.', referenceDocIds: ['doc-a', 'doc-b'] },
};

function sourceText(confirmed = true): SourceText {
  return {
    resolutions: [
      {
        bindingId: 'bind-v',
        status: 'resolved',
        candidates: [{ id: 'c1', label: 'Clause 14', pages: '5', text: 'SOURCE TEXT FROM DOC A', chars: 21 }],
        chosenCandidateId: 'c1',
        userConfirmed: confirmed,
      },
      {
        bindingId: 'bind-a',
        status: 'resolved',
        candidates: [{ id: 'c2', label: 'Pages 2-3', pages: '2-3', text: 'PAYMENT SOURCE TEXT', chars: 19 }],
        chosenCandidateId: 'c2',
        userConfirmed: confirmed,
      },
    ],
    resolvedAt: '2026-01-01T00:00:00.000Z',
    planFingerprint: '',
    outlineFingerprint: '',
  };
}

function item(id: string, over: Partial<OutlineItem> = {}): OutlineItem {
  return { id, level: 1, title: 'Section', purpose: '', kind: 'clause', bindingIds: [], ...over };
}

function draft(confirmed = true): DraftRecord {
  return {
    id: 'draft-1',
    userId: 'user-a',
    title: 'Lease',
    instruction: 'Draft a lease.',
    referenceDocIds: ['doc-a', 'doc-b'],
    reviewingFor: 'neutral',
    status: 'outlined',
    particulars: [
      { id: 'p1', label: 'Deposit', kind: 'amount', value: '50,000', source: 'instruction', required: true },
      { id: 'p2', label: 'Landlord', kind: 'party', value: null, source: 'instruction', required: true },
    ],
    sourcePlan: plan,
    outline: {
      items: [
        item('i1', { title: 'Indemnity', bindingIds: ['bind-v'] }),
        item('i2', { title: 'Payment', bindingIds: ['bind-a'] }),
        item('i3', { title: 'Term' }),
        item('i4', { title: 'Signature', kind: 'signature' }),
      ],
      notes: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      model: 'outline-model',
      planFingerprint: 'fp',
    },
    sourceText: sourceText(confirmed),
    clauses: {},
    writeRun: null,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('write estimate', () => {
  it('counts items, model calls, tokens and time', () => {
    const estimate = estimateWriting(draft(), { concurrency: 3, secondsPerCall: 18 });
    expect(estimate.items).toBe(4);
    expect(estimate.verbatimItems).toBe(1);
    expect(estimate.modelItems).toBe(3);
    // 900 + ceil(19/4) + 2 particulars * 20, then two items with no source.
    expect(estimate.inputTokens).toBe(945 + 940 + 940);
    expect(estimate.outputTokens).toBe(1200);
    expect(estimate.seconds).toBe(18);
    expect(estimate.costUsd === null || typeof estimate.costUsd === 'number').toBe(true);
  });

  it('uses the configured concurrency for the time', () => {
    expect(estimateWriting(draft(), { concurrency: 2, secondsPerCall: 10 }).seconds).toBe(20);
  });

  it('counts a verbatim copy only when the source is confirmed', () => {
    expect(estimateWriting(draft(false)).verbatimItems).toBe(0);
    expect(estimateWriting(draft(false)).modelItems).toBe(4);
  });
});
