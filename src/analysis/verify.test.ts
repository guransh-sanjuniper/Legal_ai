import { describe, it, expect } from 'vitest';
import { verifyQuote, verifyQuotedItems, normalizeQuote } from './verify';

const pages = new Map<number, string>([
  [3, 'The Developer shall hand over possession of Unit 12 on or before 31 March 2027, subject to force majeure.'],
  [4, 'The Purchaser shall pay maintenance charges every month to the society. Non payment is a breach.'],
]);

describe('quote verification', () => {
  it('accepts an exact quote', () => {
    expect(verifyQuote('hand over possession of Unit 12', 3, pages).ok).toBe(true);
  });

  it('accepts a quote whose whitespace differs (line breaks, double spaces)', () => {
    const q = 'hand over   possession\nof Unit 12';
    expect(verifyQuote(q, 3, pages).ok).toBe(true);
  });

  it('normalises smart quotes and dashes', () => {
    const p = new Map([[1, 'The “Said Land” admeasuring 7873.81 sq m – as described.']]);
    expect(verifyQuote('"Said Land" admeasuring 7873.81 sq m - as described', 1, p).ok).toBe(true);
    expect(normalizeQuote('“A” – B')).toBe('"a" - b');
  });

  it('rejects a quote that exists on a different page', () => {
    const r = verifyQuote('maintenance charges every month', 3, pages);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('quote_not_found');
  });

  it('rejects a page that does not exist', () => {
    expect(verifyQuote('hand over possession of Unit 12', 99, pages).reason).toBe('bad_page');
  });

  it('rejects a too-short or empty quote', () => {
    expect(verifyQuote('Unit', 3, pages).reason).toBe('quote_too_short');
    expect(verifyQuote('   ', 3, pages).reason).toBe('missing_quote');
  });
});

describe('per-item verification', () => {
  it('keeps verified items and drops the rest with reasons', () => {
    const out = verifyQuotedItems(
      'payment',
      [
        { amount: '100', page: 4, quote: 'pay maintenance charges every month' },
        { amount: '200', page: 4, quote: 'this sentence is not in the page' },
        { amount: '300', page: 77, quote: 'pay maintenance charges every month' },
        { amount: '400', quote: 'pay maintenance charges every month' } as never,
      ],
      pages,
    );
    expect(out.verified).toHaveLength(1);
    expect(out.verified[0].item.verified).toBe(true);
    expect(out.drops.map((d) => d.reason)).toEqual(['quote_not_found', 'bad_page', 'bad_page']);
  });

  it('returns nothing for missing arrays', () => {
    expect(verifyQuotedItems('date', undefined, pages)).toEqual({ verified: [], drops: [] });
  });
});
