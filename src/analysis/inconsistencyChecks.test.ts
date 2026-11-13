import { describe, it, expect } from 'vitest';
import { findInconsistencies } from './inconsistencyChecks';
import type { VerifiedClause, VerifiedObligation, VerifiedRisk } from './types';

const ob = (itemId: string, party: string, quote: string, page = 1): VerifiedObligation => ({
  itemId,
  clause: '1',
  party,
  text: quote,
  page,
  quote,
  verified: true,
});

const risk = (itemId: string, affects: string, quote: string, page = 1): VerifiedRisk => ({
  itemId,
  clause: '1',
  text: quote,
  severity: 'medium',
  basis: 'other',
  suggestion: 'Change it.',
  laws: [],
  affects,
  page,
  quote,
  verified: true,
  applicability: 'unverified',
});

const clause = (clauseNo: string, over: Partial<VerifiedClause> = {}): VerifiedClause => ({
  itemId: `c${clauseNo}`,
  clauseNo,
  type: 'other',
  summary: '',
  chunkId: 'analysis:0',
  chunkIndex: 0,
  pageStart: 1,
  pageEnd: 1,
  obligations: [],
  dates: [],
  payments: [],
  risks: [],
  verifiedItems: 0,
  ...over,
});

describe('internal inconsistencies', () => {
  it('flags an irrevocable grant against a termination right, with both quotes and a reason', () => {
    const findings = findInconsistencies([
      clause('3', { obligations: [ob('o1', 'Developer', 'The licence granted is irrevocable in perpetuity.')] }),
      clause('9', { obligations: [ob('o2', 'Developer', 'The Developer may terminate this agreement on thirty days notice.')] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].itemIds).toEqual(['o1', 'o2']);
    expect(findings[0].reason).toMatch(/cannot be withdrawn/);
  });

  it('flags arbitration against exclusive court jurisdiction', () => {
    const findings = findInconsistencies([
      clause('11', { obligations: [ob('a1', 'Both parties', 'Disputes shall be referred to arbitration.')] }),
      clause('12', { obligations: [ob('a2', 'Both parties', 'The courts at Pune have exclusive jurisdiction.')] }),
    ]);
    expect(findings.some((f) => /arbitration/.test(f.reason ?? ''))).toBe(true);
  });

  it('does not flag different categories or different parties', () => {
    // Commercial premises in one place, residential in another: a difference, not a conflict.
    const findings = findInconsistencies([
      clause('4', { obligations: [ob('c1', 'Licensor', 'The premises are commercial and may be used for offices.')] }),
      clause('5', { obligations: [ob('c2', 'Licensor', 'The residential premises may only be used for residence.')] }),
      clause('6', { obligations: [ob('d1', 'Architect', 'The Architect may terminate on ten days notice.')] }),
      clause('7', { obligations: [ob('d2', 'Contractor', 'The Contractor may terminate on sixty days notice.')] }),
    ]);
    expect(findings).toEqual([]);
  });

  it('reports nothing when the document has no conflicting terms', () => {
    const findings = findInconsistencies([
      clause('1', { obligations: [ob('e1', 'Buyer', 'The Buyer shall pay the price on completion.')] }),
      clause('2', { obligations: [ob('e2', 'Supplier', 'The Supplier shall deliver on completion.')] }),
    ]);
    expect(findings).toEqual([]);
  });

  it('does not flag a fee and a deposit as two figures for one subject', () => {
    const findings = findInconsistencies([
      clause('2', {
        obligations: [ob('f1', 'Licensee', 'The Licensee shall pay a licence fee of Rs. 40,000 and a security deposit of Rs. 80,000.')],
      }),
    ]);
    expect(findings).toEqual([]);
  });

  it('does not flag an escalation interval as a termination notice period', () => {
    const findings = findInconsistencies([
      clause('3', { obligations: [ob('t1', 'Licensor', 'The fee shall increase by 8% every 12 months.')] }),
      clause('7', { obligations: [ob('t2', 'Licensor', 'The Licensor may terminate this agreement on 30 days notice.')] }),
    ]);
    expect(findings).toEqual([]);
  });

  it('flags two different termination notice periods for the same right', () => {
    const findings = findInconsistencies([
      clause('7', { obligations: [ob('n1', 'Licensor', 'The Licensor may terminate this agreement on 30 days notice.')] }),
      clause('9', { obligations: [ob('n2', 'Licensor', 'The Licensor may terminate this agreement on 60 days notice.')] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toMatch(/notice periods/);
  });

  it('uses the affected party on a risk as the party category', () => {
    const findings = findInconsistencies([
      clause('20', { risks: [risk('z1', 'Licensee', 'The grant is irrevocable and perpetual.')] }),
      clause('21', { risks: [risk('z2', 'Licensee', 'The Licensee may terminate on seven days notice.')] }),
    ]);
    expect(findings).toHaveLength(1);
  });
});
