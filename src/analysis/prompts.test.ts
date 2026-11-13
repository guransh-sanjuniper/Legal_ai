import { describe, it, expect } from 'vitest';
import { buildClausePrompt, buildMissingPrompt } from './prompts';
import { normaliseRequest } from './request';

describe('clause prompt', () => {
  it('frames risks for the reviewing side only when it is not neutral', () => {
    expect(buildClausePrompt({ docType: null, detail: 'standard' })).not.toMatch(/REVIEWING FOR/);
    const licensee = buildClausePrompt({ docType: null, detail: 'standard', reviewingFor: 'licensee' });
    expect(licensee).toMatch(/REVIEWING FOR: the licensee/);
    expect(licensee).toMatch(/report every issue/);
  });

  it('lists the material one-sided patterns and asks for Act names, never section numbers', () => {
    const p = buildClausePrompt({ docType: null, detail: 'standard' });
    expect(p).toMatch(/penalty, damages or interest formula/);
    expect(p).toMatch(/forfeiture or a non-refundable deposit/);
    expect(p).toMatch(/waiver of courts/);
    expect(p).toMatch(/Name Acts only; never state a section number as certain/);
    expect(p).toMatch(/High guard|basis to that category/);
  });

  it('keeps the High rule in the rubric', () => {
    expect(buildClausePrompt({ docType: null, detail: 'standard' })).toMatch(/High is rare/);
  });
});

describe('missing prompt', () => {
  it('gives the clause list and typical protections for the document type', () => {
    const p = buildMissingPrompt({ docType: 'lease', checklistOfClauses: ['1', '2', '7'] });
    expect(p).toMatch(/Clause numbers present in this document: 1, 2, 7/);
    expect(p).toMatch(/security-deposit refund period/);
    expect(p).toMatch(/governing law and forum/);
  });
});

describe('request reviewing side', () => {
  it('defaults to neutral and accepts only the three sides', () => {
    expect(normaliseRequest({}).reviewingFor).toBe('neutral');
    expect(normaliseRequest({ reviewingFor: 'licensor' }).reviewingFor).toBe('licensor');
    expect(normaliseRequest({ reviewingFor: 'both' }).reviewingFor).toBe('neutral');
  });
});
