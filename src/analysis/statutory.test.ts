import { describe, it, expect } from 'vitest';
import { MAX_STATUTORY_ACTS, centralLawsFor, selectStatutoryLaws } from './statutory';
import { lawKey } from './rubric';

describe('statutory compliance selection', () => {
  it('keeps engaged Acts and the Acts central to the document type, and omits unrelated ones', () => {
    const out = selectStatutoryLaws({
      engaged: [{ name: 'Indian Contract Act 1872', clauses: ['2'] }],
      docType: 'lease',
      proposed: ['Companies Act 2013', 'Maharashtra Rent Control Act', 'Income-tax Act 1961'],
    });
    const names = out.map((l) => l.name);
    expect(names).toContain('Indian Contract Act 1872');
    expect(names.some((n) => /Rent Control/.test(n))).toBe(true);
    expect(names.some((n) => /Companies Act/.test(n))).toBe(false);
    expect(names.some((n) => /Income-tax/.test(n))).toBe(false);
  });

  it('never exceeds six Acts and never repeats one', () => {
    const out = selectStatutoryLaws({
      engaged: [
        { name: 'Indian Contract Act 1872', clauses: ['1'] },
        { name: 'Indian Contract Act', clauses: ['4'] },
        { name: 'Transfer of Property Act 1882', clauses: ['5'] },
        { name: 'Registration Act 1908', clauses: ['6'] },
        { name: 'Indian Stamp Act 1899', clauses: ['7'] },
      ],
      docType: 'lease',
      proposed: ['Maharashtra Rent Control Act'],
    });
    expect(out.length).toBeLessThanOrEqual(MAX_STATUTORY_ACTS);
    expect(new Set(out.map((l) => lawKey(l.name))).size).toBe(out.length);
  });

  it('shows only engaged Acts for an unknown document type', () => {
    const out = selectStatutoryLaws({
      engaged: [{ name: 'Indian Contract Act 1872', clauses: ['1'] }],
      docType: 'other',
      proposed: ['Maharashtra Rent Control Act', 'Companies Act 2013'],
    });
    expect(out.map((l) => l.name)).toEqual(['Indian Contract Act 1872']);
  });

  it('has a small, subject-based map', () => {
    expect(centralLawsFor('lease').length).toBeGreaterThan(0);
    expect(centralLawsFor('other')).toEqual([]);
    for (const type of ['lease', 'agreement', 'deed', 'notice'] as const) expect(centralLawsFor(type).length).toBeLessThanOrEqual(5);
  });
});
