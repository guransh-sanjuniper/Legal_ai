import { describe, it, expect } from 'vitest';
import { groupForRollup, keepCitedSentences, overviewTargetSentenceCount } from './rollup';

describe('roll-up grouping', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);

  it('keeps every group between 30 and 60', () => {
    for (const n of [30, 40, 61, 100, 120, 250]) {
      const groups = groupForRollup(items(n));
      for (const g of groups) {
        expect(g.length).toBeGreaterThanOrEqual(30);
        expect(g.length).toBeLessThanOrEqual(60);
      }
      expect(groups.flat()).toEqual(items(n));
    }
  });

  it('merges a short tail into the previous group instead of leaving a tiny one', () => {
    const groups = groupForRollup(items(45)); // target 45 => one group would be fine
    expect(groups).toHaveLength(1);
    const g2 = groupForRollup(items(85));
    expect(g2).toHaveLength(2);
    expect(g2.map((g) => g.length)).toEqual([43, 42]);
    expect(g2.flat()).toEqual(items(85));
  });

  it('balances a size that would leave a tiny tail', () => {
    expect(groupForRollup(items(61)).map((g) => g.length)).toEqual([31, 30]);
  });

  it('handles empty and single-batch inputs', () => {
    expect(groupForRollup([])).toEqual([]);
    expect(groupForRollup(items(10))).toEqual([items(10)]);
  });
});

describe('citation-ID dropping', () => {
  const valid = new Set(['C1:1', 'C1:2']);

  it('keeps sentences with a valid cite and removes unknown cites', () => {
    const out = keepCitedSentences(
      [
        { text: 'Possession is due in 2027.', cites: ['C1:1', 'nope'] },
        { text: 'No citation here.', cites: [] },
        { text: 'Only invented ids.', cites: ['X9'] },
        { text: 'Payments are monthly.', cites: ['C1:2'] },
      ],
      valid,
    );
    expect(out.kept.map((s) => s.text)).toEqual(['Possession is due in 2027.', 'Payments are monthly.']);
    expect(out.kept[0].cites).toEqual(['C1:1']);
    expect(out.dropped).toBe(2);
  });

  it('drops empty text even with a valid cite', () => {
    expect(keepCitedSentences([{ text: '   ', cites: ['C1:1'] }], valid).kept).toEqual([]);
  });

  it('scales overview length with document size, bounded', () => {
    expect(overviewTargetSentenceCount(10)).toBe(5);
    expect(overviewTargetSentenceCount(200)).toBe(20);
    expect(overviewTargetSentenceCount(2000)).toBe(40);
  });
});
