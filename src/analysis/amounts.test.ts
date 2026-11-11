import { describe, it, expect } from 'vitest';
import { buildAnchorIndex } from './anchors';
import { extractAmounts, parseMoney, uncapturedAmounts } from './amounts';

const pages = new Map<number, string>([
  [
    10,
    '5) Corpus\nRs. 50,00,000/- is payable by the Purchaser. Interest at 18% per annum within 30 days. Rs. ________/-',
  ],
  [11, 'Sir.\nno.\n1. First Year Rs. 52.50\n2. Second Year Rs. 57.75'],
  [12, '6) Penalty\nThe Developer shall pay Rs. 18.000/- per square feet on deficiency.'],
]);
const index = buildAnchorIndex(pages);

describe('Indian money formats', () => {
  it('parses lakh/crore grouping', () => {
    expect(parseMoney('Rs. 50,00,000/-')).toBe(5000000);
    expect(parseMoney('₹ 1,25,00,000')).toBe(12500000);
  });

  it('parses dotted thousand separators used with /-', () => {
    expect(parseMoney('18.000/-')).toBe(18000);
    expect(parseMoney('Rs. 52.50')).toBe(52.5);
  });

  it('returns null for blank placeholders and percentages', () => {
    expect(parseMoney('Rs. ________/-')).toBeNull();
    expect(parseMoney('18%')).toBe(18);
  });
});

describe('amount extraction', () => {
  const amounts = extractAmounts(index);

  it('finds money, percentages and durations with page and clause', () => {
    const corpus = amounts.find((a) => a.kind === 'money' && a.numeric === 5000000);
    expect(corpus).toMatchObject({ page: 10, clause: '5' });
    expect(amounts.some((a) => a.kind === 'percent' && a.numeric === 18 && a.clause === '5')).toBe(true);
    expect(amounts.some((a) => a.kind === 'duration' && /30 days/.test(a.text) && a.clause === '5')).toBe(true);
  });

  it('captures table rows', () => {
    expect(amounts.some((a) => a.page === 11 && a.numeric === 52.5)).toBe(true);
    expect(amounts.some((a) => a.page === 11 && a.numeric === 57.75)).toBe(true);
  });

  it('keeps the surrounding sentence as the quote', () => {
    const corpus = amounts.find((a) => a.numeric === 5000000)!;
    expect(corpus.quote).toContain('50,00,000');
    expect(corpus.quote.length).toBeGreaterThan(20);
  });

  it('lists money mentions that no verified payment covers', () => {
    const uncaptured = uncapturedAmounts(amounts, [
      { clause: '5', amount: 'Rs. 50,00,000/-', quote: 'Rs. 50,00,000/- is payable' },
    ]);
    expect(uncaptured.some((a) => a.numeric === 5000000)).toBe(false);
    expect(uncaptured.some((a) => a.numeric === 52.5)).toBe(true);
  });
});
