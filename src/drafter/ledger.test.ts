import { describe, expect, it } from 'vitest';
import { extractDefinitions, ledgerContext, ledgerFromClauses, mergeLedger } from './ledger';
import type { ClauseRecord, OutlineItem } from './types';

function clause(over: Partial<ClauseRecord> = {}): ClauseRecord {
  return {
    text: '',
    status: 'done',
    itemFingerprint: 'fp',
    sourceBindingIds: [],
    model: 'm',
    generatedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 0,
    ...over,
  };
}

function item(id: string, title: string): OutlineItem {
  return { id, level: 1, title, purpose: '', kind: 'clause', bindingIds: [] };
}

describe('defined-term ledger', () => {
  it('takes the sentence around (the "Term")', () => {
    const text =
      'The flat described in the Schedule (the "Premises") is let to the Licensee. The rent is payable monthly.';
    expect(extractDefinitions(text, 'item-1')).toEqual([
      {
        term: 'Premises',
        definition: 'The flat described in the Schedule (the "Premises") is let to the Licensee.',
        itemId: 'item-1',
      },
    ]);
  });

  it('extracts "Term" means ...', () => {
    const [entry] = extractDefinitions('"Rent" means the monthly amount payable under this agreement.', 'item-1');
    expect(entry.term).toBe('Rent');
    expect(entry.definition).toBe('the monthly amount payable under this agreement.');
  });

  it('extracts "Term" shall mean ...', () => {
    const [entry] = extractDefinitions('"Term" shall mean two years from the commencement date.', 'item-1');
    expect(entry).toMatchObject({ term: 'Term', definition: 'two years from the commencement date.' });
  });

  it('extracts an unquoted Term means ...', () => {
    const [entry] = extractDefinitions('Deposit means the security amount payable under this agreement.', 'item-1');
    expect(entry).toMatchObject({ term: 'Deposit', definition: 'the security amount payable under this agreement.' });
  });

  it('caps the definition and rejects an over-long term', () => {
    const [entry] = extractDefinitions(`"Rent" means ${'x'.repeat(400)}.`, 'item-1');
    expect(entry.definition).toHaveLength(300);
    expect(extractDefinitions(`"${'T'.repeat(70)}" means something.`, 'item-1')).toEqual([]);
  });

  it('keeps the first definition of a term', () => {
    const entries = extractDefinitions('"Rent" means the monthly amount. "Rent" means something else.', 'item-1');
    expect(entries).toHaveLength(1);
    expect(entries[0].definition).toBe('the monthly amount.');
  });

  it('merges ledgers without duplicates', () => {
    const first = extractDefinitions('"Rent" means the monthly amount.', 'i1');
    const second = extractDefinitions('"Deposit" means the security amount.', 'i2');
    const merged = mergeLedger(first, second);
    expect(merged.map((entry) => entry.term)).toEqual(['Rent', 'Deposit']);
    expect(mergeLedger(merged, first)).toHaveLength(2);
  });

  it('builds a ledger from finished clauses only and formats it', () => {
    const clauses: Record<string, ClauseRecord> = {
      i1: clause({ text: '"Rent" means the monthly amount.' }),
      i2: clause({ text: '"Deposit" means the security amount.', status: 'failed' }),
    };
    const items = [item('i1', 'Rent'), item('i2', 'Deposit')];
    expect(ledgerFromClauses(clauses, items).map((entry) => entry.term)).toEqual(['Rent']);
    expect(ledgerContext([{ term: 'Rent', definition: 'the monthly amount.', itemId: 'i1' }])).toBe(
      '- "Rent": the monthly amount.',
    );
  });
});
