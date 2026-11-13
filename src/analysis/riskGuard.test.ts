import { describe, it, expect } from 'vitest';
import { inferAffects, protectsFromDrop } from './riskGuard';
import { dropGapClaims, fallbackSummary } from './summaryGuard';
import { findInconsistencies } from './inconsistencyChecks';
import type { OverviewPoint, VerifiedClause, VerifiedObligation } from './types';

const ob = (itemId: string, party: string, quote: string): VerifiedObligation => ({
  itemId,
  clause: '1',
  party,
  text: quote,
  page: 1,
  quote,
  verified: true,
});

describe('never-drop guard', () => {
  it('protects a cost placed on a named party', () => {
    expect(
      protectsFromDrop(
        { issue: 'All stamp duty and registration charges are borne by the Licensee.', quote: 'stamp duty and registration charges shall be borne by the Licensee' },
        ['Licensee'],
      ),
    ).toBe(true);
  });

  it('protects a liability placed on a generic role', () => {
    expect(
      protectsFromDrop({ issue: 'The tenant pays all taxes and charges.', quote: 'all taxes and charges shall be paid by the tenant' }),
    ).toBe(true);
  });

  it('does not protect boilerplate that merely mentions fees or expectations', () => {
    expect(
      protectsFromDrop(
        { issue: 'The document contains forward-looking statements about fees and no assurance is given.', quote: 'no assurance is given that fees will remain unchanged' },
      ),
    ).toBe(false);
    expect(protectsFromDrop({ issue: 'Fees may change.', quote: 'fees may change from time to time' })).toBe(false);
  });
});

describe('affects inference', () => {
  it('uses a party named in the risk text', () => {
    expect(inferAffects({ issue: 'Deposit is forfeited.', quote: 'the Licensee forfeits the deposit', clauseParties: [] })).toBe('Licensee');
  });
  it('falls back to the clause party, then Both/unclear', () => {
    expect(inferAffects({ issue: 'Uncapped repairs.', quote: 'repairs shall be done', clauseParties: ['Licensor'] })).toBe('Licensor');
    expect(inferAffects({ issue: 'Unclear.', quote: 'something applies', clauseParties: [] })).toBe('Both/unclear');
  });
  it('never returns the old placeholder for an ordinary risk', () => {
    expect(inferAffects({ issue: 'x', quote: 'y', clauseParties: ['A', 'B'] })).not.toBe('Not identified');
  });
});

describe('summary guard', () => {
  it('drops an absence claim when the Missing list has no verified entry', () => {
    const r = dropGapClaims(
      [{ text: 'There is no governing law clause.' }, { text: 'The agreement records the fee and the parties.' }],
      false,
    );
    expect(r.kept.map((s) => s.text)).toEqual(['The agreement records the fee and the parties.']);
    expect(r.dropped).toBe(1);
  });
  it('keeps a sentence that merely contains "not"', () => {
    const r = dropGapClaims([{ text: 'The fee is not subject to escalation.' }], false);
    expect(r.kept).toHaveLength(1);
  });
  it('keeps absence claims when a verified missing entry exists', () => {
    const r = dropGapClaims([{ text: 'There is no governing law clause.' }], true);
    expect(r.kept).toHaveLength(1);
  });
  it('builds a short fallback from nature, parties and key terms', () => {
    const point = (p: number, text: string): OverviewPoint => ({ point: p, title: `P${p}`, sentences: [{ text, cites: ['C1'] }] });
    const points = [point(1, 'It is a licence.'), point(2, 'Between two parties.'), point(4, 'Fee is set.'), point(8, 'Termination on notice.')];
    const out = fallbackSummary(points);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out.map((s) => s.text)).toContain('It is a licence.');
  });
});

describe('non-contract disclosure text', () => {
  // Disclosure-style wording: fees and penalty words, no assurance boilerplate, no conflicting
  // terms. It must not produce false inconsistencies, and its boilerplate stays droppable.
  const clause: VerifiedClause = {
    itemId: 'c1',
    clauseNo: '1',
    type: 'other',
    summary: 'Disclosure.',
    chunkId: 'analysis:0',
    chunkIndex: 0,
    pageStart: 1,
    pageEnd: 1,
    obligations: [
      ob('o1', 'Issuer', 'The Issuer will pay fees of Rs. 40,000 and annual charges of Rs. 8,000.'),
      ob('o2', 'Issuer', 'The Issuer gives no assurance that fees will remain unchanged.'),
      ob('o3', 'Issuer', 'Penalties may apply to late payment of fees.'),
    ],
    dates: [],
    payments: [],
    risks: [],
    verifiedItems: 3,
  };

  it('produces no false inconsistencies', () => {
    expect(findInconsistencies([clause])).toEqual([]);
  });

  it('keeps boilerplate droppable', () => {
    expect(
      protectsFromDrop(
        { issue: 'Forward-looking statements about fees.', quote: 'no assurance is given that fees will remain unchanged' },
      ),
    ).toBe(false);
  });

  it('makes no gap claim without a verified missing entry', () => {
    const r = dropGapClaims(
      [{ text: 'There is no assurance that fees will remain unchanged.' }, { text: 'The Issuer pays fees and charges.' }],
      false,
    );
    expect(r.kept).toHaveLength(1);
  });
});
