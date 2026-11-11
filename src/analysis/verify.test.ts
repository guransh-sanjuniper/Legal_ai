import { describe, it, expect } from 'vitest';
import { buildAnchorIndex, resolveQuote } from './anchors';
import { verifyQuotedItems, normalizeQuote } from './verify';

const pages = new Map<number, string>([
  [3, '2) Appointment\nThe Society appoints the Developer to redevelop the property.'],
  [4, 'The Developer shall pay the corpus amount to the Society.\n(a) The Developer shall pay interest at eighteen percent on delay.'],
  [5, 'The Purchaser shall pay maintenance every month.'],
]);
const index = buildAnchorIndex(pages);

describe('page correction and clause resolution', () => {
  it('finds a quote on the cited page and its clause', () => {
    const r = resolveQuote(index, 'Society appoints the Developer', 3, { start: 3, end: 4 });
    expect(r).toMatchObject({ page: 3, clause: '2', corrected: false });
  });

  it('corrects the page when the quote is on another page of the chunk', () => {
    const r = resolveQuote(index, 'pay the corpus amount to the Society', 3, { start: 3, end: 4 });
    expect(r).toMatchObject({ page: 4, clause: '2', corrected: true });
  });

  it('resolves a sub-item quote to a sub-clause label', () => {
    const r = resolveQuote(index, 'pay interest at eighteen percent on delay', 4, { start: 3, end: 4 });
    expect(r).toMatchObject({ page: 4, clause: '2(a)', corrected: false });
  });

  it('falls back to the whole document when outside the chunk range', () => {
    const r = resolveQuote(index, 'pay maintenance every month', 3, { start: 3, end: 3 });
    // Page 5 has no new clause boundary, so the sentence continues the previous sub-item paragraph.
    expect(r).toMatchObject({ page: 5, clause: '2(a)', corrected: true });
  });

  it('returns null when the quote is nowhere', () => {
    expect(resolveQuote(index, 'this sentence does not exist anywhere', 3, { start: 3, end: 5 })).toBeNull();
  });

  it('normalises whitespace, quotes, dashes and hyphenated line breaks', () => {
    expect(normalizeQuote('“Said Land”  develop-\nment – ok')).toBe('"said land" development - ok');
  });
});

describe('per-item verification', () => {
  it('keeps located items with corrected page/clause and drops unseen ones', () => {
    const out = verifyQuotedItems(
      'payment',
      [
        { amount: '100', page: 3, quote: 'Society appoints the Developer' },
        { amount: '200', page: 3, quote: 'pay the corpus amount to the Society' },
        { amount: '300', page: 3, quote: 'this quote is nowhere at all' },
        { amount: '400', page: 3, quote: 'tiny' },
      ],
      index,
      { start: 3, end: 4 },
    );
    expect(out.verified).toHaveLength(2);
    expect(out.corrected).toBe(1);
    expect(out.verified[1].item.page).toBe(4);
    expect(out.drops.map((d) => d.reason)).toEqual(['not_found', 'quote_too_short']);
  });

  it('returns nothing for a missing array', () => {
    expect(verifyQuotedItems('date', undefined, index, { start: 3, end: 3 })).toEqual({ verified: [], drops: [], corrected: 0 });
  });
});
