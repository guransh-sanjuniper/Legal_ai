import { describe, it, expect } from 'vitest';
import { NO_SUGGESTION, guardPriority, normaliseLaws, normaliseMissing, normaliseProse, riskBasisOf, sortByPriority } from './rubric';
import { normaliseRequest } from './request';
import { LAW_CHECKLIST, lawChecklistPrompt } from './lawChecklist';

describe('risk priority guard', () => {
  it('keeps High only for a reserved basis', () => {
    expect(guardPriority('high', 'illegal')).toBe('high');
    expect(guardPriority('high', 'void_or_unenforceable')).toBe('high');
    expect(guardPriority('high', 'statutory_violation')).toBe('high');
    expect(guardPriority('high', 'major_financial_exposure')).toBe('high');
  });

  it('caps High at Medium for any other or unknown basis', () => {
    expect(guardPriority('high', 'other')).toBe('medium');
    expect(guardPriority('high', 'made_up')).toBe('medium');
    expect(guardPriority('high', undefined)).toBe('medium');
  });

  it('defaults an unknown priority to Medium and keeps Low', () => {
    expect(guardPriority('urgent', 'illegal')).toBe('medium');
    expect(guardPriority(undefined, 'other')).toBe('medium');
    expect(guardPriority('low', 'illegal')).toBe('low');
  });

  it('maps unknown bases to other', () => {
    expect(riskBasisOf('illegal')).toBe('illegal');
    expect(riskBasisOf('nonsense')).toBe('other');
  });
});

describe('field normalisation', () => {
  it('trims, dedupes case-insensitively and caps law names', () => {
    expect(normaliseLaws(['  Act A  ', 'act a', '', 3, 'Act B'])).toEqual(['Act A', 'Act B']);
    expect(normaliseLaws('Act A')).toEqual([]);
    expect(normaliseLaws(Array.from({ length: 20 }, (_, i) => `Act ${i}`))).toHaveLength(8);
  });

  it('keeps missing entries as text, deduped', () => {
    expect(normaliseMissing(['No notice period', 'no notice period', '  '])).toEqual(['No notice period']);
    expect(normaliseMissing(undefined)).toEqual([]);
  });

  it('fills every prose key, empty when absent', () => {
    const p = normaliseProse({ conditions: '  Only on signing. ', rights: 7 });
    expect(p.conditions).toBe('Only on signing.');
    expect(p.rights).toBe('');
    expect(Object.keys(p)).toHaveLength(8);
    expect(normaliseProse(null).detailed_summary).toBe('');
  });

  it('uses a visible fallback text, not an invented suggestion', () => {
    expect(NO_SUGGESTION).toMatch(/lawyer/);
  });
});

describe('priority order', () => {
  it('sorts High, Medium, Low and keeps input order within a priority', () => {
    const items = [
      { id: 'a', severity: 'low' as const },
      { id: 'b', severity: 'high' as const },
      { id: 'c', severity: 'medium' as const },
      { id: 'd', severity: 'high' as const },
    ];
    expect(sortByPriority(items).map((x) => x.id)).toEqual(['b', 'd', 'c', 'a']);
  });
});

describe('request defaults', () => {
  it('defaults detail to standard and bounds the free text', () => {
    const r = normaliseRequest({ detailLevel: 'bogus', focus: '  x  ', customPrompt: '' });
    expect(r.detailLevel).toBe('standard');
    expect(r.focus).toBe('x');
    expect(r.customPrompt).toBe('');
    expect(normaliseRequest({ detailLevel: 'brief' }).detailLevel).toBe('brief');
    expect(normaliseRequest(undefined).matter).toBe('');
    expect(normaliseRequest({ focus: 'f'.repeat(900) }).focus).toHaveLength(300);
  });
});

describe('law checklist', () => {
  it('has no duplicate entries and keeps the mapped names', () => {
    expect(new Set(LAW_CHECKLIST).size).toBe(LAW_CHECKLIST.length);
    expect(LAW_CHECKLIST.some((x) => x.startsWith('Bharatiya Sakshya Adhiniyam 2023'))).toBe(true);
    expect(LAW_CHECKLIST).toContain('Industrial Disputes Act 1947');
    expect(LAW_CHECKLIST.some((x) => x.includes('BNNS'))).toBe(false);
  });

  it('is framed as a checklist, not a limit, with no section numbers requested', () => {
    const text = lawChecklistPrompt();
    expect(text).toMatch(/not a limit/);
    expect(text).toMatch(/never section numbers/);
  });
});
