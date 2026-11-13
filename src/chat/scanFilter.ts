import type { AnalysisChunk } from '../analysis/analysisChunks';
import { significantTerms } from './route';

// Whole-document chat only. A loose local filter: a section is skipped only when it shares no term
// with the question. It never ranks sections, so anything with a term is always scanned.
// Terms are matched by their first six characters, the same loose stem the coverage check uses.

const PREFIX = 6;
const prefix = (w: string) => w.slice(0, PREFIX);

const wordSets = new WeakMap<AnalysisChunk, Set<string>>();

function sectionWords(c: AnalysisChunk): Set<string> {
  let words = wordSets.get(c);
  if (!words) {
    words = new Set(c.text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(prefix));
    wordSets.set(c, words);
  }
  return words;
}

export type ScanReason = 'terms' | 'no-terms' | 'no-match';

export interface ScanSelection {
  // The sections to scan, in document order.
  chunks: AnalysisChunk[];
  terms: string[];
  total: number;
  scanned: number;
  skipped: number;
  // terms: some sections were skipped. no-terms: the question had no terms, so all are scanned.
  // no-match: no section contains any term, so all are scanned rather than none.
  reason: ScanReason;
}

export function selectChunksForQuestion(chunks: AnalysisChunk[], question: string): ScanSelection {
  const terms = significantTerms(question);
  const total = chunks.length;
  if (terms.length === 0) {
    return { chunks, terms, total, scanned: total, skipped: 0, reason: 'no-terms' };
  }
  const wanted = terms.map(prefix);
  const matched = chunks.filter((c) => {
    const words = sectionWords(c);
    return wanted.some((t) => words.has(t));
  });
  if (matched.length === 0) {
    return { chunks, terms, total, scanned: total, skipped: 0, reason: 'no-match' };
  }
  return {
    chunks: matched,
    terms,
    total,
    scanned: matched.length,
    skipped: total - matched.length,
    reason: 'terms',
  };
}

// One line for the estimate and the answer: what was scanned and why the rest was not.
export function scanNote(s: ScanSelection): string {
  const terms = s.terms.join(', ');
  if (s.reason === 'no-terms') {
    return `Your question had no specific terms, so all ${s.total} sections were scanned.`;
  }
  if (s.reason === 'no-match') {
    return `No section mentions your terms (${terms}), so all ${s.total} sections were scanned.`;
  }
  if (s.skipped === 0) {
    return `Scanned all ${s.total} sections; every one matched your terms (${terms}).`;
  }
  return `Scanned ${s.scanned} of ${s.total} sections; ${s.skipped} had no match for your terms (${terms}).`;
}
