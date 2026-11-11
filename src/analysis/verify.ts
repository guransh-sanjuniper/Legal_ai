export interface QuoteLike {
  quote?: unknown;
  page?: unknown;
}

export type DropReason =
  | 'missing_quote'
  | 'quote_too_short'
  | 'bad_page'
  | 'quote_not_found'
  | 'invalid_shape';

export interface Drop {
  kind: string;
  reason: DropReason;
  page: number | null;
  quote: string;
}

export interface Verified<T extends QuoteLike> {
  item: T & { page: number; quote: string; verified: true };
}

const MIN_QUOTE_CHARS = 8;

export function normalizeQuote(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00A0/g, ' ')
    // Join words split by a PDF line-break hyphen ("develop-\nment").
    .replace(/(\p{L})-\s+(\p{L})/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function pageTextKey(page: number): string {
  return `p${page}`;
}

// Checks that a quote exists, after whitespace normalisation, on the cited stored page.
export function verifyQuote(
  quote: string,
  page: number,
  pages: Map<number, string>,
): { ok: boolean; reason?: DropReason } {
  const q = normalizeQuote(quote);
  if (q.length === 0) return { ok: false, reason: 'missing_quote' };
  if (q.length < MIN_QUOTE_CHARS) return { ok: false, reason: 'quote_too_short' };
  const text = pages.get(page);
  if (text === undefined) return { ok: false, reason: 'bad_page' };
  if (!normalizeQuote(text).includes(q)) return { ok: false, reason: 'quote_not_found' };
  return { ok: true };
}

// Verifies every quoted item of one clause. Verified items are returned; the rest are
// dropped and counted with a reason.
export function verifyQuotedItems<T extends QuoteLike>(
  kind: string,
  items: T[] | undefined,
  pages: Map<number, string>,
): { verified: Verified<T>[]; drops: Drop[] } {
  const verified: Verified<T>[] = [];
  const drops: Drop[] = [];
  for (const item of items ?? []) {
    const quote = typeof item.quote === 'string' ? item.quote : '';
    const page = typeof item.page === 'number' && Number.isFinite(item.page) ? item.page : null;
    const quoteText = quote.trim();
    if (page === null) {
      drops.push({ kind, reason: 'bad_page', page: null, quote: quoteText });
      continue;
    }
    const result = verifyQuote(quote, page, pages);
    if (!result.ok) {
      drops.push({ kind, reason: result.reason!, page, quote: quoteText });
      continue;
    }
    verified.push({ item: { ...item, page, quote: quoteText, verified: true } });
  }
  return { verified, drops };
}

export function quotedItemsOf(clause: {
  obligations?: unknown;
  dates?: unknown;
  payments?: unknown;
  risks?: unknown;
}): { kind: string; items: QuoteLike[] }[] {
  const pick = (v: unknown): QuoteLike[] => (Array.isArray(v) ? (v as QuoteLike[]) : []);
  return [
    { kind: 'obligation', items: pick(clause.obligations) },
    { kind: 'date', items: pick(clause.dates) },
    { kind: 'payment', items: pick(clause.payments) },
    { kind: 'risk', items: pick(clause.risks) },
  ];
}
