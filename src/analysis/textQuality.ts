import type { AnchorIndex } from './anchors';
import { normalizeQuote } from './verify';
import type { DraftingIssueGroup, DraftingIssues } from './types';

// Unfilled blanks and reviewer comments are found by code, never by the model, and never treated
// as contract terms. Signature and witness blocks are excluded: only operative text, recitals and
// schedules are counted.

const BLANKS = [/_{3,}/g, /\[\s*\]/g, /_{2,}\s*(?:days?|weeks?|months?|years?)/gi];
const COMMENTS = [/commented\s*\[[^\]]*\]/gi, /\[\s*(?:note|tbc|tbd|insert|to be (?:confirmed|inserted|added)|draft|placeholder)[^\]]*\]/gi];

// Signature lines in any format: a block heading, a party label with underscores, or a bare
// witness/signature line. The region after the last operative clause is signature material unless
// a schedule or annexure heading follows.
const SIGNATURE_START =
  /^\s*(in witness whereof|signed (?:and delivered|sealed|by)|witness(?:es)?\b|signature\b|in the presence of|name\s*:|date\s*:)/i;
// A signature party label: capitalised words only ("LICENSOR: ____", "Name of Witness ____"),
// never an ordinary sentence that happens to end in underscores.
const PARTY_SIGNATURE =
  /^\s*(?:[A-Z]{2,}(?:[ .&()'-]+[A-Z]{2,}){0,5}|[A-Z][a-z]+(?:[ .&()'-]+[A-Z][a-z]+){0,3})\s*[:\-]?\s*_{3,}/;
// "Licensor: Name ____" and similar: a label, a short name, then the blank.
const PARTY_NAME_BLANK = /^\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s*:\s*[A-Za-z][A-Za-z .'-]{0,40}_{3,}/;
const SIGNATURE_WORD = /\b(witness|witnesses|signed|signature|in the presence of)\b/i;
const BLOCK_END = /^\s*(schedule|annexure|part\s+[A-Z0-9]|article\s+[A-Z0-9])\b/i;
const OPERATIVE_CLAUSE = /^\s*\d{1,3}(?:\.\d{1,3})*[.)]\s+\S/;

export function isSignatureLine(line: string): boolean {
  return SIGNATURE_START.test(line) || PARTY_SIGNATURE.test(line) || PARTY_NAME_BLANK.test(line) || SIGNATURE_WORD.test(line);
}

// Lines excluded from the blanks count, per page, in source order.
export function excludedLines(text: string): Set<string> {
  const lines = text.split('\n').map((l) => l.trim());
  const excluded = new Set<string>();
  let lastOperative = -1;
  let scheduleAt = -1;
  lines.forEach((line, i) => {
    if (OPERATIVE_CLAUSE.test(line)) lastOperative = i;
    if (BLOCK_END.test(line)) scheduleAt = i;
  });

  // The trailing region after the last operative clause is signature material only when it
  // actually contains signature lines; otherwise those lines are the last clause's body.
  if (lastOperative >= 0 && (scheduleAt < 0 || scheduleAt > lastOperative)) {
    const end = scheduleAt > lastOperative ? scheduleAt : lines.length;
    const tail = lines.slice(lastOperative + 1, end);
    const firstSignature = tail.findIndex((l) => l && isSignatureLine(l));
    if (firstSignature >= 0) for (const l of tail.slice(firstSignature)) if (l) excluded.add(l);
  }

  let inSignature = false;
  for (const line of lines) {
    if (!line) continue;
    if (excluded.has(line)) continue;
    if (!inSignature && isSignatureLine(line)) inSignature = true;
    else if (inSignature && BLOCK_END.test(line)) inSignature = false;
    if (inSignature) excluded.add(line);
  }
  return excluded;
}

// One blank is counted once, even when two patterns match it ("___ days" also matches "___").
export function findBlanks(line: string): string[] {
  const found: { start: number; end: number; text: string }[] = [];
  for (const re of BLANKS) {
    for (const m of line.matchAll(re)) {
      const start = m.index ?? 0;
      found.push({ start, end: start + m[0].length, text: m[0].trim() });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: string[] = [];
  let lastEnd = -1;
  for (const m of found) {
    if (m.start < lastEnd) continue;
    out.push(m.text);
    lastEnd = m.end;
  }
  return out;
}

export function findComments(line: string): string[] {
  const out: string[] = [];
  for (const re of COMMENTS) for (const m of line.matchAll(re)) out.push(m[0].trim());
  return out;
}

// A blank that touches money, time or a party is a risk; decorative blanks are not.
export function blankAffectsTerm(line: string): boolean {
  return /(\brs\.?\b|inr|amount|fee|deposit|rent|interest|%|\bdays?\b|\bweeks?\b|\bmonths?\b|\byears?\b|date|party|name|\bshall\b|\bagrees?\b|\bundertakes?\b)/i.test(line);
}

export function signatureBlockLines(pages: Map<number, string>): Set<string> {
  const inBlock = new Set<string>();
  for (const text of pages.values()) for (const line of excludedLines(text)) inBlock.add(line);
  return inBlock;
}

// Maps each source line to the clause it sits in, using the anchor segments for that page.
function clauseForLine(index: AnchorIndex, page: number, line: string, fallback: string): string {
  const segs = index.byPage.get(page) ?? [];
  const norm = normalizeQuote(line);
  if (!norm) return fallback;
  for (const seg of segs) if (seg.norm.includes(norm)) return seg.clause;
  return fallback;
}

export function extractDraftingIssues(pages: Map<number, string>, index: AnchorIndex): DraftingIssues {
  const skip = signatureBlockLines(pages);
  const groups = new Map<string, DraftingIssueGroup>();
  let blankCount = 0;
  let commentCount = 0;

  for (const pageNo of [...pages.keys()].sort((a, b) => a - b)) {
    let fallback = 'preamble';
    for (const raw of (pages.get(pageNo) ?? '').split('\n')) {
      const line = raw.trim();
      if (!line || skip.has(line)) continue;
      const blanks = findBlanks(line);
      if (blanks.length === 0 && findComments(line).length === 0) {
        // Keep the clause context moving as numbered lines pass, even when they have no issue.
        fallback = clauseForLine(index, pageNo, line, fallback);
        continue;
      }
      const clause = clauseForLine(index, pageNo, line, fallback);
      fallback = clause;
      const key = `${clause}|${pageNo}`;
      const group = groups.get(key) ?? { clause, page: pageNo, blanks: [], comments: [] };
      if (blanks.length) {
        blankCount += blanks.length;
        if (!group.blanks.includes(line)) group.blanks.push(line);
      }
      const comments = findComments(line);
      if (comments.length) {
        commentCount += comments.length;
        if (!group.comments.includes(line)) group.comments.push(line);
      }
      groups.set(key, group);
    }
  }

  return {
    blankCount,
    commentCount,
    groups: [...groups.values()].sort((a, b) => a.page - b.page || a.clause.localeCompare(b.clause)),
  };
}
