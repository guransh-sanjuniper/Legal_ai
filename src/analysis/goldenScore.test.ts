import { describe, it, expect } from 'vitest';
import { scorePayments, scoreDeveloperFavour } from './goldenScore';
import type { JudgementRow } from './judgement';

const report = {
  clauses: [
    {
      clauseNo: '16',
      payments: [
        { amount: 'Rs. 1,000', quote: 'corpus of Rs. 1,000 per square feet', due: 'on execution' },
        { amount: '50%', quote: '50% of the corpus on execution', due: '' },
      ],
    },
  ],
  amounts: {
    code: [
      { kind: 'money', numeric: 5000000, text: 'Rs. 50,00,000', clause: '22', quote: 'guarantee of Rs. 50,00,000' },
    ],
  },
};

const expected = [
  { clause: '16', label: 'corpus', amount: 1000 },
  { clause: '16', label: 'half', percent: 50 },
  { clause: '22', label: 'guarantee', amount: 5000000 },
];

describe('payment recall', () => {
  it('reports model-only and model+code recall separately', () => {
    const r = scorePayments(report as never, expected as never);
    expect(r.expected).toBe(3);
    expect(r.modelFound).toBe(2);
    expect(r.combinedFound).toBe(3);
    expect(r.modelRecall).toBeCloseTo(2 / 3);
    expect(r.combinedRecall).toBe(1);
    expect(r.modelMisses.map((m) => m.clause)).toEqual(['22']);
    expect(r.combinedMisses).toEqual([]);
  });

  it('does not count a matching amount in the wrong clause', () => {
    const r = scorePayments(report as never, [{ clause: '99', label: 'wrong clause', amount: 1000 }] as never);
    expect(r.modelFound).toBe(0);
  });
});

describe('developer-favour scoring', () => {
  const rows: JudgementRow[] = [
    { clause: '2', page: 10, why: 'rights granted', quote: 'The Society grants development rights', direction: 'favours_developer', confidence: 'high', itemIds: [] },
    { clause: '23(a)', page: 41, why: 'time extension', quote: 'The Developer shall be entitled to an extension', direction: 'favours_developer', confidence: 'high', itemIds: [] },
    { clause: '30', page: 50, why: 'burden called a favour', quote: 'The Developer shall pay the corpus to the Society', direction: 'favours_developer', confidence: 'high', itemIds: [] },
    { clause: '39', page: 58, why: 'society right', quote: 'The Society may inspect the work', direction: 'favours_society', confidence: 'high', itemIds: [] },
  ];

  it('reports recall, misses and false favours', () => {
    const r = scoreDeveloperFavour(rows, ['2', '23(a)', '24', '39']);
    expect(r.found).toBe(2);
    expect(r.recall).toBe(0.5);
    expect(r.misses).toEqual(['24', '39']);
    expect(r.falseFavours.map((f) => f.clause)).toEqual(['30']);
  });
});
