import { describe, it, expect } from 'vitest';
import type { Citation, ReportModel } from '../analysis/reportModel';
import { SAVED_ROW_LIMIT, citationFields, contentTokens, routeQuestion, savedRowsFor, uniqueCitations } from './route';

// A small stored-report model with the sections the router reads. Only those fields are filled.
const deposit: Citation = { clause: '4', page: 3, quote: 'a deposit of Rs 50,000' };
const forfeit: Citation = { clause: '9', page: 8, quote: 'the Landlord may forfeit the deposit' };
const rent: Citation = { clause: '3', page: 2, quote: 'pay the rent by the 5th' };

const model = {
  clauses: [
    {
      clauseNo: '4',
      rows: [
        { label: 'Summary', text: 'The tenant pays a refundable deposit.', items: [], citations: [deposit], modelWritten: true, conditional: false },
      ],
    },
  ],
  sections: [
    {
      key: 'datesAmounts',
      title: 'Dates and Amounts',
      number: 6,
      dates: [{ date: '1 April 2026', purpose: 'Lease start', timing: 'fixed', clause: '2', citation: { clause: '2', page: 1, quote: 'from 1 April 2026' } }],
      amounts: [
        {
          amount: 'Rs 50,000',
          purpose: 'Security deposit',
          payerToPayee: 'Tenant to Landlord',
          due: 'on signing',
          clause: '4',
          citation: deposit,
        },
        {
          amount: 'Rs 25,000',
          purpose: 'Monthly rent',
          payerToPayee: 'Tenant to Landlord',
          due: 'by the 5th',
          clause: '3',
          citation: rent,
        },
      ],
    },
    {
      key: 'risks',
      title: 'Risk Register',
      number: 7,
      risks: [
        {
          priority: 'high',
          clause: '9',
          affects: 'Tenant',
          issue: 'Landlord may forfeit the deposit without notice',
          suggestion: '',
          laws: [],
          kind: 'risk',
          pages: 'page 8',
          citation: forfeit,
        },
      ],
      missing: [
        { priority: 'medium', clause: '', affects: 'Both', issue: 'No dispute resolution clause', suggestion: '', laws: [], kind: 'missing', pages: '', citation: null },
      ],
    },
    {
      key: 'obligations',
      title: 'Obligations by Party',
      number: 5,
      groups: [{ party: 'Tenant', rows: [{ clause: '3', page: 2, text: 'Pay the rent by the 5th of each month', citation: rent }] }],
    },
  ],
} as unknown as ReportModel;

describe('routeQuestion', () => {
  it('answers from the saved report when a stored amount matches', () => {
    const r = routeQuestion("what's the deposit amount?", model, false);
    expect(r.mode).toBe('saved');
    if (r.mode !== 'saved') return;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].text).toContain('Rs 50,000');
    expect(r.rows[0].citation).toEqual(deposit);
    expect(r.total).toBe(1);
  });

  it('answers a clause question from the stored clause summary', () => {
    const r = routeQuestion('what does clause 4 say?', model, false);
    expect(r.mode).toBe('saved');
    if (r.mode !== 'saved') return;
    expect(r.rows[0].text).toBe('The tenant pays a refundable deposit.');
    expect(r.rows[0].citation).toEqual(deposit);
  });

  it('falls back to retrieval when the clause is not in the report', () => {
    expect(routeQuestion('what does clause 99 say?', model, false)).toEqual({ mode: 'retrieval' });
  });

  it('answers a missing-protections question from the missing list', () => {
    const r = routeQuestion('is anything missing?', model, false);
    expect(r.mode).toBe('saved');
    if (r.mode !== 'saved') return;
    expect(r.rows[0].label).toMatch(/Missing protection/);
    expect(r.rows[0].citation).toBeNull();
  });

  it('answers an obligation question from the obligations rows', () => {
    const r = routeQuestion('what must the tenant do?', model, false);
    expect(r.mode).toBe('saved');
    if (r.mode !== 'saved') return;
    expect(r.rows[0].label).toBe('Tenant · clause 3');
  });

  it('misses when one specific word of the question is not in any row', () => {
    // "rent" appears in the monthly rent row, but "penalty" and "late" do not, so it is a miss.
    expect(routeQuestion('what is the penalty for late rent?', model, false)).toEqual({ mode: 'retrieval' });
  });

  it('misses a question the report does not cover at all', () => {
    expect(routeQuestion('does the lease allow pets?', model, false)).toEqual({ mode: 'retrieval' });
  });

  it('uses retrieval when there is no saved report', () => {
    expect(routeQuestion("what's the deposit amount?", null, false)).toEqual({ mode: 'retrieval' });
  });

  it('runs the whole-document scan when asked, even if the report would answer', () => {
    expect(routeQuestion("what's the deposit amount?", model, true)).toEqual({ mode: 'whole' });
    expect(routeQuestion('anything else?', null, true)).toEqual({ mode: 'whole' });
  });

  it('returns every row of a kind for a generic question', () => {
    const r = savedRowsFor("what's the amount?", model);
    expect(r?.rows.map((x) => x.label)).toEqual(['Amount: Security deposit', 'Amount: Monthly rent']);
  });

  it('caps the rows and reports the total', () => {
    const many = {
      ...model,
      sections: [
        {
          key: 'datesAmounts',
          title: 'Dates and Amounts',
          number: 6,
          dates: [],
          amounts: Array.from({ length: SAVED_ROW_LIMIT + 3 }, (_, i) => ({
            amount: `Rs ${i}`,
            purpose: 'Fee',
            payerToPayee: 'Tenant to Landlord',
            due: 'monthly',
            clause: String(i),
            citation: { clause: String(i), page: 1, quote: `fee ${i}` },
          })),
        },
      ],
    } as unknown as ReportModel;
    const r = routeQuestion('what are the fees?', many, false);
    expect(r.mode).toBe('saved');
    if (r.mode !== 'saved') return;
    expect(r.rows).toHaveLength(SAVED_ROW_LIMIT);
    expect(r.total).toBe(SAVED_ROW_LIMIT + 3);
  });
});

describe('contentTokens', () => {
  it('drops short and stop words and stems plurals', () => {
    expect(contentTokens('What are the deposits of the tenant?')).toEqual(['deposit', 'tenant']);
  });
});

describe('citations kept on a message', () => {
  it('keeps only page, clause and quote', () => {
    const extra = { ...deposit, chunkText: 'the whole section' } as Citation & { chunkText: string };
    expect(citationFields(extra)).toEqual(deposit);
    expect(Object.keys(citationFields(extra)).sort()).toEqual(['clause', 'page', 'quote']);
  });

  it('removes repeats and missing entries, keeping the first', () => {
    const list = uniqueCitations([deposit, null, { ...deposit }, rent, undefined]);
    expect(list).toEqual([deposit, rent]);
  });
});
