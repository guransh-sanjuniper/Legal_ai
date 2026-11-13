import { quoteMatchesRequest } from './questionTerms';

// Checks on a synthesised answer, before it is shown. Pure: no I/O, no model call.
//   1. Subject: an answer is kept only when its quote has every concept of the request. A concept is
//      a significant term or one of its listed synonyms (synonyms.ts). A quote about a related but
//      different thing (another notice, a rate table) is not an answer.
//   2. Numbers: every number in a sentence must appear in a quote it cites, and a unit the quote
//      gives next to that number (Rs, %, day, month, year, week) must appear in the sentence.
// A quote this subject check rejects gets one second chance from a batched model judgement
// (answerRelevance.ts, checkRelevance in promptPass.ts). The check never replaces this one.

// Answers whose quote states the subject of the request. A request with no terms keeps everything.
export function answersAboutQuestion<T extends { quote: string }>(answers: T[], request: string): T[] {
  return answers.filter((a) => quoteMatchesRequest(a.quote, request));
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
// A number after these words is a reference (clause 4, section 12.3, page 7), not an amount.
const REFERENCE = /(clause|section|article|page|cl\.?|p\.)\s*$/i;

const UNIT_WORD = '%|per\\s?cent|percent|rs\\.?|inr|₹|rupees?|days?|months?|years?|weeks?';
const UNIT_AFTER = new RegExp(`^\\s*(?:(?:per|a|an|each)\\s+)?(${UNIT_WORD})(?![a-z])`, 'i');
const UNIT_BEFORE = /(rs\.?|inr|₹|rupees?)\s*$/i;
const UNIT_ANYWHERE = new RegExp(`(?<![a-z])(${UNIT_WORD})(?![a-z])`, 'gi');

// One canonical name per unit, so "Rs.", "INR", "rupees" and "₹" compare equal.
export function canonicalUnit(raw: string): string {
  const u = raw.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  if (['rs', 'inr', '₹', 'rupee', 'rupees'].includes(u)) return 'rs';
  if (['%', 'percent', 'per cent'].includes(u)) return '%';
  if (u === 'day' || u === 'days') return 'day';
  if (u === 'month' || u === 'months') return 'month';
  if (u === 'year' || u === 'years') return 'year';
  if (u === 'week' || u === 'weeks') return 'week';
  return u;
}

function unitsIn(text: string): Set<string> {
  return new Set([...text.matchAll(UNIT_ANYWHERE)].map((m) => canonicalUnit(m[0])));
}

// Each occurrence of `value` in a quote, with the units the quote gives next to it.
function occurrences(quote: string, value: string): string[][] {
  const out: string[][] = [];
  for (const m of quote.matchAll(NUMBER)) {
    if (m[0].replace(/,/g, '') !== value) continue;
    const idx = m.index ?? 0;
    const end = idx + m[0].length;
    const units: string[] = [];
    const before = UNIT_BEFORE.exec(quote.slice(Math.max(0, idx - 8), idx));
    if (before) units.push(canonicalUnit(before[1]));
    const after = UNIT_AFTER.exec(quote.slice(end, end + 24));
    if (after) units.push(canonicalUnit(after[1]));
    out.push(units);
  }
  return out;
}

// Problems with one sentence, given the quotes it cites. An empty list means it passes.
export function numericProblems(sentence: string, citedQuotes: string[]): string[] {
  const problems: string[] = [];
  const shown = unitsIn(sentence);
  for (const m of sentence.matchAll(NUMBER)) {
    const idx = m.index ?? 0;
    if (REFERENCE.test(sentence.slice(Math.max(0, idx - 12), idx))) continue;
    const value = m[0].replace(/,/g, '');
    const hits = citedQuotes.flatMap((q) => occurrences(q, value));
    if (hits.length === 0) {
      problems.push(`${m[0]} is not in the cited quote`);
      continue;
    }
    for (const unit of new Set(hits.flat())) {
      if (!shown.has(unit)) problems.push(`${m[0]} is missing its unit (${unit})`);
    }
  }
  return problems;
}
