import type { AnchorIndex } from './anchors';
import { resolveQuote } from './anchors';

export interface QuoteLike {
  quote?: unknown;
  page?: unknown;
}

export type DropReason = 'missing_quote' | 'quote_too_short' | 'not_found' | 'invalid_shape';

export interface Drop {
  kind: string;
  reason: DropReason;
  page: number | null;
  quote: string;
}

export interface Located<T extends QuoteLike> {
  item: T & { page: number; quote: string; verified: true; clause: string };
  corrected: boolean;
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

// Locates every quoted item: cited page, then the chunk range, then the whole document.
// Page and clause come from where the quote was found; only unseen quotes are dropped.
export function verifyQuotedItems<T extends QuoteLike>(
  kind: string,
  items: T[] | undefined,
  index: AnchorIndex,
  range: { start: number; end: number },
): { verified: Located<T>[]; drops: Drop[]; corrected: number } {
  const verified: Located<T>[] = [];
  const drops: Drop[] = [];
  let corrected = 0;

  for (const item of items ?? []) {
    const quote = typeof item.quote === 'string' ? item.quote.trim() : '';
    const page = typeof item.page === 'number' && Number.isFinite(item.page) ? item.page : null;
    if (!quote) {
      drops.push({ kind, reason: 'missing_quote', page, quote: '' });
      continue;
    }
    if (normalizeQuote(quote).length < MIN_QUOTE_CHARS) {
      drops.push({ kind, reason: 'quote_too_short', page, quote });
      continue;
    }
    const found = resolveQuote(index, quote, page, range);
    if (!found) {
      drops.push({ kind, reason: 'not_found', page, quote });
      continue;
    }
    if (found.corrected) corrected++;
    verified.push({
      corrected: found.corrected,
      item: { ...item, page: found.page, quote, verified: true, clause: found.clause },
    });
  }
  return { verified, drops, corrected };
}
