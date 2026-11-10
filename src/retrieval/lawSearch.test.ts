import { describe, it, expect } from 'vitest';
import { lawSearchKeyword, LAW_PASSAGES, LAW_NOTICE } from './lawSearch';

describe('law stand-in', () => {
  it('has about 20 passages and is clearly marked as test data', () => {
    expect(LAW_PASSAGES.length).toBeGreaterThanOrEqual(20);
    expect(LAW_NOTICE).toMatch(/TEST DATA ONLY/);
    expect(LAW_NOTICE).toMatch(/NOT statutes/i);
  });

  const clauses: [string, string][] = [
    ['the promoter delayed handing over possession beyond the agreed date', 'L01'],
    ['non payment of maintenance charges by a member', 'L03'],
    ['the society executes a power of attorney in favour of the developer for redevelopment permissions', 'L04'],
    ['stamp duty and registration charges payable on the agreement', 'L05'],
    ['disputes between the parties referred to arbitration', 'L07'],
  ];

  for (const [clause, expected] of clauses) {
    it(`returns ${expected} for: ${clauses.find((c) => c[0] === clause)![0].slice(0, 40)}…`, () => {
      const hits = lawSearchKeyword(clause, 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.slice(0, 2).map((h) => h.id)).toContain(expected);
    });
  }
});
