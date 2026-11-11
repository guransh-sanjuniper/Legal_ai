import { describe, it, expect } from 'vitest';
import {
  canonicalClause,
  detectSide,
  filterBySide,
  looksLikeBurdenOn,
  mergeJudgements,
  quoteOverlap,
  subItemGroups,
  type JudgementItem,
  type Parties,
} from './judgement';
import { buildAnchorIndex } from './anchors';

const PARTIES: Parties = { a: 'Alpha Holdings Limited', b: 'Beta Members Association' };

const item = (over: Partial<JudgementItem>): JudgementItem => ({
  itemId: 'J1:1',
  clause: '2',
  page: 10,
  quote: 'The first party grants development rights to the second party.',
  direction: 'favours_a',
  why: 'The first party grants an irrevocable right.',
  confidence: 'high',
  ...over,
});

describe('canonical clauses', () => {
  it('normalises spacing and punctuation', () => {
    expect(canonicalClause('23 (a)')).toBe('23(a)');
    expect(canonicalClause('23A.')).toBe('23a');
  });
});

describe('dedupe and grouping', () => {
  it('dedupes quotes that overlap and keeps one row', () => {
    const base = item({});
    const { rows } = mergeJudgements([
      base,
      { ...base, itemId: 'J2:1', why: 'second wording' },
      item({ itemId: 'J3:1', clause: '3', quote: 'A different clause three quotation text', direction: 'neutral' }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('groups by clause, sorts by clause number and prefers a benefit over neutral', () => {
    const { rows, directions } = mergeJudgements([
      item({ itemId: 'a', clause: '25', quote: 'A distinct clause twenty five quote here' }),
      item({ itemId: 'b', clause: '2', quote: 'A distinct clause two quote here', direction: 'neutral' }),
      item({ itemId: 'c', clause: '2', quote: 'A completely different clause two quotation text', direction: 'favours_b' }),
      item({ itemId: 'd', clause: '23(a)', quote: 'A distinct sub clause quote text here' }),
    ]);
    expect(rows.map((r) => r.clause)).toEqual(['2', '23(a)', '25']);
    expect(rows.find((r) => r.clause === '2')!.direction).toBe('favours_b');
    expect(directions).toEqual({ favours_a: 2, favours_b: 1, neutral: 0 });
  });

  it('detects quote overlap only for substantial shared text', () => {
    expect(quoteOverlap('The first party grants development rights', 'the first party grants development rights')).toBe(true);
    expect(quoteOverlap('The first party grants rights', 'The second party pays money')).toBe(false);
  });
});

describe('side selection', () => {
  const rows = mergeJudgements([
    item({ itemId: 'a', clause: '2', quote: 'A distinct favour for the first party here' }),
    item({ itemId: 'b', clause: '3', quote: 'A distinct favour for the second party here', direction: 'favours_b' }),
    item({ itemId: 'c', clause: '4', quote: 'A distinct neutral quote text here', direction: 'neutral' }),
  ]).rows;

  it('keeps only the matching side when a party is named', () => {
    const { matching, others } = filterBySide(rows, 'a');
    expect(matching.map((r) => r.clause)).toEqual(['2']);
    expect(others.map((r) => r.clause)).toEqual(['3', '4']);
  });

  it('returns everything when no side is named', () => {
    expect(filterBySide(rows, null).matching).toHaveLength(3);
  });

  it('detects the side from a party name in the question', () => {
    expect(detectSide('Which clauses favour Alpha Holdings Limited?', PARTIES)).toBe('a');
    expect(detectSide('Which clauses favour Beta Members Association?', PARTIES)).toBe('b');
    expect(detectSide('Which clauses favour both?', PARTIES)).toBeNull();
    expect(detectSide('Which clauses favour Gamma?', { a: null, b: null })).toBeNull();
  });
});

describe('burden correction', () => {
  it('flags a burden on the named party labelled as a benefit to it', () => {
    expect(looksLikeBurdenOn('Alpha Holdings Limited shall pay the amount to the members.', 'benefit', PARTIES.a)).toBe(true);
  });

  it('does not flag a genuine right of the named party', () => {
    expect(looksLikeBurdenOn('Alpha Holdings Limited shall be entitled to assign its rights.', 'benefit', PARTIES.a)).toBe(false);
  });

  it('never flags when the party is unknown', () => {
    expect(looksLikeBurdenOn('Alpha Holdings Limited shall pay the amount.', 'benefit', null)).toBe(false);
  });
});

describe('sub-item groups (synthetic text)', () => {
  const pages = new Map<number, string>([
    [
      1,
      [
        '5) Payments',
        'The first party shall pay the deposit within the period.',
        '(a) first sub item text that is quite long and keeps going for a while.',
        '(b) second sub item text that is also long enough to matter here.',
        '(i) roman sub item under the second group of text here.',
        '6) Termination',
        '(a) only sub item of the next clause in this synthetic document.',
      ].join('\n'),
    ],
  ]);

  it('groups sub-items per parent clause and never across clauses', () => {
    const groups = subItemGroups(buildAnchorIndex(pages), 10_000);
    expect(groups.map((g) => g.clause)).toEqual(['5', '6']);
    expect(groups[0].text).toContain('(a) first sub item');
    expect(groups[0].text).toContain('(i) roman sub item');
    expect(groups[1].text).not.toContain('(i)');
  });

  it('splits a clause into several groups when the text exceeds the size limit', () => {
    const groups = subItemGroups(buildAnchorIndex(pages), 80);
    expect(groups.filter((g) => g.clause === '5').length).toBeGreaterThan(1);
  });
});

describe('sub-items after a unit without a clause number', () => {
  it('keeps the enclosing clause as the prefix of the sub-item', () => {
    const pages = new Map<number, string>([
      [1, '5) Payments\nbody text here.\nB. A lettered heading line.\n(b) sub item after the heading.\n6) Next\nbody'],
    ]);
    const labels = buildAnchorIndex(pages).segments.map((s) => s.clause);
    expect(labels).toContain('5(b)');
  });
});
