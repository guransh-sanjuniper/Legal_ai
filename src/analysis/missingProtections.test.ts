import { describe, it, expect } from 'vitest';
import { keepMissingClaims, missingPlans, isValidMissingItem } from './missingProtections';
import { NO_SUGGESTION } from './rubric';

const none = async () => [];
const found = async () => [{ fused: 0.4 }];

describe('missing protections', () => {
  it('keeps a claim only when the document search finds nothing', async () => {
    const items = [
      { topic: 'governing law', text: 'No governing law clause.', priority: 'medium', basis: 'other', suggestion: 'Add one.', laws: ['Indian Contract Act 1872'], cites: ['C1:1:1'] },
      { topic: 'notice period', text: 'No notice period.', priority: 'high', basis: 'illegal', suggestion: 'Add one.', laws: [], cites: [] },
    ];
    const kept = await keepMissingClaims(items, new Set(['C1:1:1']), async (q) => (q === 'notice period' ? [] : [{ fused: 0.4 }]));
    expect(kept.kept.map((m) => m.topic)).toEqual(['notice period']);
    expect(kept.coveredInDocument).toBe(1);
    expect(kept.kept[0]).toMatchObject({ itemId: 'M1', severity: 'high', applicability: 'unverified' });
  });

  it('drops a claim whose search fails rather than showing it as checked', async () => {
    const boom = async () => {
      throw new Error('search down');
    };
    const r = await keepMissingClaims([{ topic: 'x', text: 'y', priority: 'low', basis: 'other', suggestion: 's', laws: [], cites: [] }], new Set(), boom);
    expect(r.kept).toEqual([]);
    expect(r.unchecked).toBe(1);
  });

  it('keeps only valid clause cites and a visible fallback for a missing suggestion', async () => {
    const r = await keepMissingClaims(
      [{ topic: 'deposit', text: 'No deposit refund.', priority: 'low', basis: 'other', cites: ['C1:1:1', 'ghost'] }],
      new Set(['C1:1:1']),
      none,
    );
    expect(r.kept[0].cites).toEqual(['C1:1:1']);
    expect(r.kept[0].suggestion).toBe(NO_SUGGESTION);
  });

  it('dedupes topics and ignores invalid items', async () => {
    const r = await keepMissingClaims(
      [
        { topic: 'Insurance', text: 'a', priority: 'low', basis: 'other', suggestion: 's', laws: [], cites: [] },
        { topic: 'insurance', text: 'b', priority: 'low', basis: 'other', suggestion: 's', laws: [], cites: [] },
        { topic: 42, text: 'bad' },
      ],
      new Set(),
      none,
    );
    expect(r.kept).toHaveLength(1);
  });

  it('keeps a search hit as coverage, not as a gap', async () => {
    const r = await keepMissingClaims([{ topic: 'stamp duty', text: 't', priority: 'low', basis: 'other', suggestion: 's' }], new Set(), found);
    expect(r.kept).toEqual([]);
    expect(r.coveredInDocument).toBe(1);
  });

  it('splits clauses into small task groups with the focus in the prompt', () => {
    const clauses = Array.from({ length: 70 }, (_, i) => ({ id: `C${i}`, clause: String(i), type: 'other', summary: 's' }));
    const plans = missingPlans(clauses, 'defs', 'deposits');
    expect(plans.length).toBeGreaterThan(1);
    expect(plans[0].prompt).toMatch(/deposits/);
    expect(isValidMissingItem({ topic: 't', text: 'x' })).toBe(true);
  });
});
