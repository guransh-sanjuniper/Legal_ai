// Finds a stored quote in the text items of one PDF page, so the citation panel can highlight it.
// Only letters and digits take part in the match, in order, lower-cased. Spaces, punctuation and
// line-break hyphens are ignored on both sides, so a quote split across lines still matches.

export interface PageItem {
  str: string;
}

// A highlighted run inside one text item: character offsets, end exclusive.
export interface Span {
  item: number;
  start: number;
  end: number;
}

const KEEP = /[\p{L}\p{N}]/u;
const MIN_KEY = 6;

export function quoteKey(text: string): string {
  let out = '';
  for (const ch of text) if (KEEP.test(ch)) out += ch.toLowerCase();
  return out;
}

// Returns the spans that cover the quote, or null when it cannot be found on this page.
export function locateQuote(items: PageItem[], quote: string): Span[] | null {
  const key = quoteKey(quote);
  if (key.length < MIN_KEY) return null;

  const owners: { item: number; pos: number }[] = [];
  let full = '';
  items.forEach((it, i) => {
    for (let p = 0; p < it.str.length; p++) {
      const ch = it.str[p];
      if (!KEEP.test(ch)) continue;
      full += ch.toLowerCase();
      owners.push({ item: i, pos: p });
    }
  });

  const at = full.indexOf(key);
  if (at < 0) return null;
  const first = owners[at];
  const last = owners[at + key.length - 1];

  const spans: Span[] = [];
  for (let i = first.item; i <= last.item; i++) {
    const len = items[i].str.length;
    const start = i === first.item ? first.pos : 0;
    const end = i === last.item ? last.pos + 1 : len;
    if (end > start) spans.push({ item: i, start, end });
  }
  return spans;
}
