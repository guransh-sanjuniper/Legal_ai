import { describe, it, expect } from 'vitest';
import { scorePayments, scoreFavours, isTuningGolden, normToken, clauseMatch, type GoldenExpectation } from './goldenScore';
import type { JudgementRow } from './judgement';

const report = {
  clauses: [
    {
      clauseNo: '16',
      summary: 'Corpus payment terms',
      payments: [
        { amount: 'Rs. 1,000', quote: 'corpus of Rs. 1,000 per square feet', due: 'on execution' },
        { amount: '50%', quote: '50% of the corpus on execution', due: '' },
      ],
    },
  ],
  amounts: {
    code: [{ kind: 'money', numeric: 5000000, text: 'Rs. 50,00,000', clause: '22', quote: 'guarantee of Rs. 50,00,000' }],
  },
};

const expected: GoldenExpectation[] = [
  { clause: '16', token: '1,000', kind: 'payment' },
  { clause: '16', token: '50%', kind: 'payment' },
  { clause: '22', token: '50,00,000', kind: 'payment' },
];

describe('token and clause matching', () => {
  it('ignores commas, spaces and dotted thousands', () => {
    expect(normToken('Rs. 18.000/-')).toContain(normToken('18,000'));
    expect(normToken('1,00,000')).toBe('100000');
  });

  it('a bare clause matches its sub-items; a sub-item needs the same sub-item', () => {
    expect(clauseMatch('23', '23(a)')).toBe(true);
    expect(clauseMatch('23(a)', '23(a)')).toBe(true);
    expect(clauseMatch('23(a)', '23(f)')).toBe(false);
  });
});

describe('payment recall', () => {
  it('reports model-only and model+code recall separately', () => {
    const r = scorePayments(report as never, expected);
    expect(r.expected).toBe(3);
    expect(r.modelFound).toBe(2);
    expect(r.combinedFound).toBe(3);
    expect(r.modelMisses.map((m) => m.token)).toEqual(['50,00,000']);
    expect(r.combinedMisses).toEqual([]);
  });

  it('does not count a matching token in the wrong clause', () => {
    const r = scorePayments(report as never, [{ clause: '99', token: '1,000', kind: 'payment' }]);
    expect(r.modelFound).toBe(0);
  });
});

describe('favour recall', () => {
  const rows: JudgementRow[] = [
    { clause: '2', page: 10, why: 'rights granted', quote: 'The first party grants rights', direction: 'favours_a', confidence: 'high', itemIds: [] },
    { clause: '23(a)', page: 41, why: 'extension', quote: 'The first party is entitled to an extension', direction: 'favours_a', confidence: 'high', itemIds: [] },
    { clause: '39', page: 58, why: 'other side', quote: 'The second party may inspect', direction: 'favours_b', confidence: 'high', itemIds: [] },
    { clause: '40', page: 59, why: 'unexpected', quote: 'The first party may do something', direction: 'favours_a', confidence: 'high', itemIds: [] },
  ];
  const parties = { a: 'Alpha Holdings Limited', b: 'Beta Members Association' };
  const favours: GoldenExpectation[] = [
    { clause: '2', token: 'alpha', kind: 'favour' },
    { clause: '23(a)', token: 'alpha', kind: 'favour' },
    { clause: '24', token: 'alpha', kind: 'favour' },
    { clause: '39', token: 'beta', kind: 'favour' },
  ];

  it('reports recall, misses and favours outside the golden list', () => {
    const r = scoreFavours(rows, favours, parties);
    expect(r.found).toBe(3);
    expect(r.misses.map((m) => m.clause)).toEqual(['24']);
    expect(r.falseFavours.map((f) => f.clause)).toEqual(['40']);
  });

  it('a sub-item expectation is not satisfied by another sub-item', () => {
    const r = scoreFavours([rows[0]], [{ clause: '2(c)', token: 'alpha', kind: 'favour' }], parties);
    expect(r.found).toBe(0);
  });
});

describe('golden files', () => {
  it('holdout files are excluded from the tuning report', () => {
    expect(isTuningGolden({ expected: [] })).toBe(true);
    expect(isTuningGolden({ holdout: true, expected: [] })).toBe(false);
  });
});
