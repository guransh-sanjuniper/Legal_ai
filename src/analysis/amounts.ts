// Deterministic money / percentage / duration extraction. Pure code: it does not classify
// what a payment is for, it only finds amounts and their surrounding sentence.
import type { AnchorIndex } from './anchors';
import { normalizeQuote } from './verify';

export type AmountKind = 'money' | 'percent' | 'duration';

export interface ExtractedAmount {
  kind: AmountKind;
  text: string;
  amount: string;
  numeric: number | null;
  page: number;
  clause: string;
  quote: string;
}

const MONEY_RES: { re: RegExp; kind: AmountKind }[] = [
  { re: /(?:Rs\.?|₹|INR)[ \t]*[\d][\d,]*(?:\.\d+)?[ \t]*(?:\/-)?/gi, kind: 'money' },
  { re: /Rupees[^.\n]{0,60}?Only/gi, kind: 'money' },
  { re: /\b\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\s*\/-/g, kind: 'money' },
  { re: /(?:Rs\.?|₹)[ \t]*_+[ \t]*\/?-/gi, kind: 'money' },
  { re: /\b\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\b/g, kind: 'money' },
  { re: /\b\d{1,3}(?:\.\d{3})+\s*\/-/g, kind: 'money' }, // 18.000/-
  { re: /\b\d{1,3}(?:\.\d+)?\s*%/g, kind: 'percent' },
  {
    re: /\b(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|thirty|sixty|ninety)(?:\s*\(\d+\))?\s+(?:days?|weeks?|months?|years?)\b/gi,
    kind: 'duration',
  },
];

export function parseMoney(raw: string): number | null {
  // Indian lakh/crore grouping uses commas; "18.000/-" uses dots as thousand separators.
  if (/^\s*(?:rs\.?\s*)?\d{1,3}(?:\.\d{3})+\s*\/-?\s*$/i.test(raw)) {
    const digits = raw.replace(/\D/g, '');
    return digits ? Number(digits) : null;
  }
  const m = raw.replace(/[₹]/g, '').match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const cleaned = m[0].replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function sentenceAround(text: string, start: number, end: number): string {
  let from = Math.max(0, text.lastIndexOf('.', start));
  from = from < 0 ? 0 : from + 1;
  let to = text.indexOf('.', end);
  to = to < 0 ? Math.min(text.length, end + 160) : to + 1;
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

export function extractAmounts(index: AnchorIndex): ExtractedAmount[] {
  const out: ExtractedAmount[] = [];
  const seen = new Set<string>();

  for (const pageNo of [...index.pages.keys()].sort((a, b) => a - b)) {
    const text = index.pages.get(pageNo) ?? '';
    const segments = index.byPage.get(pageNo) ?? [];
    for (const { re, kind } of MONEY_RES) {
      const rx = new RegExp(re.source, re.flags);
      let m: RegExpExecArray | null;
      while ((m = rx.exec(text))) {
        const raw = m[0].trim();
        if (!raw || raw.includes('\n')) continue;
        if (kind === 'money' && !/\d/.test(raw.replace(/\d{1,3}(?=,)/g, ''))) continue;
        const position = m.index;
        let clause = segments[0]?.clause ?? 'preamble';
        for (const seg of segments) {
          const i = text.indexOf(seg.text.slice(0, Math.min(40, seg.text.length)));
          if (i >= 0 && i <= position) clause = seg.clause;
        }
        const numeric = kind === 'money' ? parseMoney(raw) : kind === 'percent' ? parseMoney(raw) : null;
        const quote = sentenceAround(text, m.index, m.index + raw.length);
        // Include the sentence so the same duration in different clauses/sentences (e.g. the
        // deposit and the brokerage both saying "one month") is not collapsed.
        const key = `${pageNo}|${clause}|${normalizeQuote(raw)}|${kind}|${normalizeQuote(quote).slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, text: raw, amount: raw, numeric, page: pageNo, clause, quote });
      }
    }
  }
  return out;
}

// Money mentions that no verified payment covers, matched by clause and numeric value.
export function uncapturedAmounts(
  amounts: ExtractedAmount[],
  payments: { clause: string; amount: string; quote: string }[],
): ExtractedAmount[] {
  return amounts.filter((a) => {
    if (a.kind !== 'money' || a.numeric === null) return false;
    if (a.text.includes('_')) return false; // blank placeholder has no amount
    return !payments.some((p) => {
      const pc = p.clause.replace(/\(.*$/, '');
      const ac = a.clause.replace(/\(.*$/, '');
      if (pc !== ac) return false;
      const n = parseMoney(p.amount);
      if (n !== null && Math.abs(n - a.numeric!) < 0.01) return true;
      return normalizeQuote(p.quote).includes(normalizeQuote(a.text));
    });
  });
}
