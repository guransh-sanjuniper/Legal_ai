import { describe, it, expect } from 'vitest';
import type { VerifiedClause } from './types';
import { dedupeVerifiedClauses } from './dedupe';

function clause(itemId: string, page: number, quote: string): VerifiedClause {
  return {
    itemId,
    clauseNo: '1',
    type: 'other',
    summary: '',
    chunkId: 'analysis:0',
    chunkIndex: 0,
    pageStart: page,
    pageEnd: page,
    obligations: [
      { itemId: `${itemId}:o0`, clause: '1', party: 'A', text: 'obligation', page, quote, verified: true },
    ],
    dates: [],
    payments: [],
    risks: [],
    verifiedItems: 1,
  };
}

describe('dedupeVerifiedClauses', () => {
  it('removes the same quote on the same page and reports before/after', () => {
    const result = dedupeVerifiedClauses([
      clause('a', 10, 'The Developer shall provide the occupancy certificate to the Society.'),
      clause('b', 10, 'The Developer shall provide the occupancy certificate to the Society.'),
    ]);
    expect(result.stats.itemsBefore).toBe(2);
    expect(result.stats.itemsAfter).toBe(1);
    expect(result.stats.removed).toBe(1);
    expect(result.clauses).toHaveLength(2); // clauses are kept unless dropEmpty is set
    expect(result.clauses[1].obligations).toHaveLength(0);
  });

  it('removes heavy quote overlap on the same page but keeps it on another page', () => {
    const quote = 'The Developer shall provide the occupancy certificate to the Society before handover of possession.';
    const near = 'The Developer shall provide the occupancy certificate to the Society before handover.';
    const same = dedupeVerifiedClauses([clause('a', 10, quote), clause('b', 10, near)]);
    expect(same.stats.removed).toBe(1);
    const otherPage = dedupeVerifiedClauses([clause('a', 10, quote), clause('b', 11, quote)]);
    expect(otherPage.stats.removed).toBe(0);
  });

  it('drops empty clauses when asked (structure-free mode)', () => {
    const result = dedupeVerifiedClauses(
      [clause('a', 10, 'The Developer shall provide the occupancy certificate.'), clause('b', 10, 'The Developer shall provide the occupancy certificate.')],
      { dropEmpty: true },
    );
    expect(result.stats.clausesBefore).toBe(2);
    expect(result.stats.clausesAfter).toBe(1);
  });
});
