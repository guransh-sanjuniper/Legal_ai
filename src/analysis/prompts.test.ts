import { describe, it, expect } from 'vitest';
import { buildClausePrompt, buildExecutiveSummaryPrompt, buildMissingPrompt, buildPromptSynthesisPrompt, buildStatutoryPrompt } from './prompts';
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

  it('does not default law references to the Contract Act, and lists the material cost risks', () => {
    const p = buildClausePrompt({ docType: 'lease', detail: 'standard' });
    expect(p).toMatch(/Do not default to the Indian Contract Act 1872/);
    expect(p).toMatch(/returns? \[\]|return \[\]/);
    expect(p).toMatch(/Statutory costs \(stamp duty, registration, taxes\) shifted wholly to one party/);
    expect(p).toMatch(/Asymmetric notice or termination rights are at least Medium/);
    expect(p).toMatch(/waiver of access to courts/);
  });

  it('asks the missing pass for up to ten protections', () => {
    expect(buildMissingPrompt({ docType: 'lease' })).toMatch(/up to 10 typical protections/);
  });

  it('caps statutory compliance at six Acts and omits unrelated ones', () => {
    const p = buildStatutoryPrompt();
    expect(p).toMatch(/at most six Acts/);
    expect(p).toMatch(/Omit any Act unrelated to the document subject matter/);
  });

  it('asks for short promptAnswer quotes only when a prompt is set, and caps them at five', () => {
    const without = buildClausePrompt({ docType: 'lease', detail: 'standard' });
    expect(without).not.toMatch(/promptAnswer/);
    const withPrompt = buildClausePrompt({ docType: 'lease', detail: 'standard', customPrompt: 'Which clauses state the fee?' });
    expect(withPrompt).toMatch(/"promptAnswer"/);
    expect(withPrompt).toMatch(/up to 5 short verbatim quotes/);
    expect(withPrompt).toMatch(/The user request is: Which clauses state the fee\?/);
  });

  it('does not ask for an execution and attestation block in the missing pass', () => {
    expect(buildMissingPrompt({ docType: 'lease' })).not.toMatch(/attestation/);
  });

  it('demands one JSON array with example objects for the synthesis and summary', () => {
    for (const p of [buildPromptSynthesisPrompt(), buildExecutiveSummaryPrompt()]) {
      expect(p).toMatch(/entire reply is one JSON array/);
      expect(p).toMatch(/never a bare string/);
      expect(p).toMatch(/Example reply: \[\{"text"/);
      expect(p).not.toMatch(/Write a short paragraph\./);
    }
  });
});
