import { describe, it, expect } from 'vitest';
import {
  canonicalClause,
  detectParty,
  filterByParty,
  looksLikeDeveloperObligation,
  mergeJudgements,
  quoteOverlap,
  type JudgementItem,
} from './judgement';

const item = (over: Partial<JudgementItem>): JudgementItem => ({
  itemId: 'J1:1',
  clause: '2',
  page: 10,
  quote: 'The Society grants development rights to the Developer.',
  direction: 'favours_developer',
  why: 'The Society grants an irrevocable right.',
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
    const { rows } = mergeJudgements([
      { ...items()[0] },
      { ...items()[0], itemId: 'J2:1', why: 'second wording' },
      { ...items()[2] },
    ]);
    expect(rows).toHaveLength(2);
  });

  it('groups by clause, sorts by clause number and prefers developer direction', () => {
    const { rows, directions } = mergeJudgements([
      item({ itemId: 'a', clause: '25', quote: 'A distinct clause twenty five quote here' }),
      item({ itemId: 'b', clause: '2', quote: 'A distinct clause two quote here' }),
      item({ itemId: 'c', clause: '2', quote: 'A completely different clause two quotation text', direction: 'favours_society' }),
      item({ itemId: 'd', clause: '23(a)', quote: 'A distinct sub clause quote text here' }),
    ]);
    expect(rows.map((r) => r.clause)).toEqual(['2', '23(a)', '25']);
    expect(rows.find((r) => r.clause === '2')!.direction).toBe('favours_developer');
    expect(directions.favours_developer).toBe(3);
    expect(directions.favours_society).toBe(0);
  });

  it('detects quote overlap', () => {
    expect(quoteOverlap('The Society grants development rights', 'the society grants development rights')).toBe(true);
    expect(quoteOverlap('The Society grants rights', 'The Developer pays money')).toBe(false);
  });
});

describe('party filtering', () => {
  const rows = mergeJudgements([
    item({ itemId: 'a', clause: '2', quote: 'A distinct developer favour quote here' }),
    item({ itemId: 'b', clause: '3', quote: 'A distinct society favour quote here', direction: 'favours_society' }),
    item({ itemId: 'c', clause: '4', quote: 'A distinct neutral quote text here', direction: 'neutral' }),
  ]).rows;

  it('keeps only matching direction when a party is named', () => {
    const { matching, others } = filterByParty(rows, 'developer');
    expect(matching.map((r) => r.clause)).toEqual(['2']);
    expect(others.map((r) => r.clause)).toEqual(['3', '4']);
  });

  it('returns everything when no party is named', () => {
    expect(filterByParty(rows, null).matching).toHaveLength(3);
  });

  it('detects the party from the question', () => {
    expect(detectParty('Which clauses favour the Developer?', null)).toBe('developer');
    expect(detectParty('Which clauses favour the Society members?', null)).toBe('society');
    expect(detectParty('Which clauses are unusual?', null)).toBeNull();
  });
});

describe('false favour heuristic', () => {
  it('flags a Developer obligation labelled as a Developer favour', () => {
    expect(looksLikeDeveloperObligation('The Developer shall pay the corpus to the Society.', 'Favours developer')).toBe(true);
  });

  it('does not flag a genuine Developer right', () => {
    expect(looksLikeDeveloperObligation('The Developer shall be entitled to assign its rights.', 'Favours developer')).toBe(false);
  });
});

function items(): JudgementItem[] {
  return [
    item({ itemId: 'J1:1' }),
    item({ itemId: 'J1:1' }),
    item({ itemId: 'J3:1', clause: '3', quote: 'A different clause three quotation text', direction: 'neutral' }),
  ];
}
