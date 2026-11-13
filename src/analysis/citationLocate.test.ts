import { describe, it, expect } from 'vitest';
import { locateQuote, quoteKey } from './citationLocate';
import { estimateRun } from './costEstimate';

describe('quote location', () => {
  it('finds a quote across text items, ignoring spacing and line-break hyphens', () => {
    const items = [{ str: 'The Developer shall' }, { str: ' perform obl-' }, { str: 'igation 2.' }];
    const spans = locateQuote(items, 'The Developer shall perform obligation 2.');
    expect(spans).toEqual([
      { item: 0, start: 0, end: 19 },
      { item: 1, start: 0, end: 13 },
      { item: 2, start: 0, end: 9 },
    ]);
  });

  it('returns null when the quote is not on the page', () => {
    expect(locateQuote([{ str: 'Unrelated text on this page.' }], 'The Developer shall perform obligation 2.')).toBeNull();
  });

  it('refuses very short quotes that would match anywhere', () => {
    expect(locateQuote([{ str: 'the the the' }], 'the')).toBeNull();
    expect(quoteKey('Rs. 12,345/-')).toBe('rs12345');
  });
});

describe('cost estimate', () => {
  const base = {
    clausePrompt: 'You analyse clauses. '.repeat(50),
    defsContext: 'Parties: A and B.',
    chunkTexts: ['[[p1]] text '.repeat(200), '[[p2]] text '.repeat(200)],
    clauseCount: 20,
    summaryChars: 4000,
    budget: 2000,
    detail: 'standard' as const,
    focus: '',
    customPrompt: '',
  };

  it('adds the custom pass only when the prompt is filled', () => {
    const without = estimateRun(base);
    const withPrompt = estimateRun({ ...base, customPrompt: 'Which clauses name a notice period?' });
    expect(without.customCalls).toBe(0);
    expect(without.synthesisCalls).toBe(0);
    expect(withPrompt.synthesisCalls).toBe(1);
    expect(without.reviewCalls).toBeGreaterThan(0);
    expect(withPrompt.customCalls).toBe(base.chunkTexts.length);
    expect(withPrompt.calls).toBe(without.calls + base.chunkTexts.length + withPrompt.synthesisCalls);
    expect(withPrompt.costUsd).toBeGreaterThan(without.costUsd);
  });

  it('treats whitespace-only custom text as not filled', () => {
    expect(estimateRun({ ...base, customPrompt: '   ' }).customCalls).toBe(0);
  });

  it('grows with the output budget and is zero-cost for an empty document', () => {
    expect(estimateRun({ ...base, budget: 4000 }).costUsd).toBeGreaterThan(estimateRun(base).costUsd);
    const empty = estimateRun({ ...base, chunkTexts: [], clauseCount: 0, summaryChars: 0 });
    expect(empty.calls).toBe(0);
  });
});
