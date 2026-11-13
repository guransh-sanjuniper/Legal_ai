// The words of a request that name its subject. Shared by chat routing and by the answer guard in
// synthesis, so both decide "about the question" the same way. Pure.

import { CONCEPT_GROUPS } from './synonyms';

// Words that name the kind of thing asked about, not the thing itself. A request made only of these
// has no subject to check an answer against.
export const GENERIC = new Set([
  'amount', 'amounts', 'pay', 'payment', 'payments', 'payable', 'paid', 'money', 'cost', 'price', 'fee', 'fees',
  'charge', 'charges', 'date', 'dates', 'deadline', 'deadlines', 'due', 'when', 'risk', 'risks', 'liability',
  'liabilities', 'obligation', 'obligations', 'duty', 'duties', 'responsibility', 'responsibilities', 'party',
  'parties', 'much', 'many', 'missing', 'term', 'notice', 'period', 'periods', 'must', 'have', 'has',
]);

const STOP = new Set([
  'what', 'which', 'where', 'how', 'does', 'doesn', 'the', 'and', 'for', 'are', 'was', 'were', 'will', 'shall',
  'that', 'this', 'with', 'from', 'into', 'about', 'under', 'have', 'has', 'document', 'agreement', 'contract',
  'clause', 'say', 'says', 'tell', 'give', 'show', 'find', 'there', 'their', 'them', 'they', 'your', 'you', 'can',
  'any', 'all', 'not', 'our', 'its', 'per', 'also', 'than', 'then', 'who', 'why', 'anything', 'something',
]);

const stem = (w: string) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

// Lower-case words of three letters or more, minus stop words, with a simple plural stem.
export function contentTokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem);
  return [...new Set(words)];
}

// The words of a request that name its subject: content words minus generic ones.
export function significantTerms(request: string): string[] {
  return contentTokens(request).filter((t) => !GENERIC.has(t));
}

// Loose word match: the first six characters, so an unlisted "terminating" still meets "terminate".
const PREFIX = 6;
const prefix = (w: string) => w.slice(0, PREFIX);

// Each word of a concept group maps to the group's concept. A word outside every group keeps its
// own prefix as its concept, so it only matches itself (or a word that shares its six characters).
const CONCEPT_OF = new Map<string, string>();
for (const [concept, entries] of Object.entries(CONCEPT_GROUPS)) {
  for (const word of entries.flatMap((e) => e.split(' '))) CONCEPT_OF.set(stem(word), `concept:${concept}`);
}

export function conceptOf(word: string): string {
  const s = stem(word.toLowerCase());
  return CONCEPT_OF.get(s) ?? prefix(s);
}

// The concepts a request needs. Used only by the answer guard; chat routing keeps its literal terms.
export function requestConcepts(request: string): string[] {
  return [...new Set(significantTerms(request).map(conceptOf))];
}

// True when the quote has every concept of the request. A request with no concepts has no subject
// to check, so it returns true (nothing is rejected). Synonyms widen a match; they never remove a
// concept the request needs.
export function quoteMatchesRequest(quote: string, request: string): boolean {
  const needed = requestConcepts(request);
  if (needed.length === 0) return true;
  const have = new Set(quote.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(conceptOf));
  return needed.every((c) => have.has(c));
}
