import type { ClauseRecord, OutlineItem } from './types';

// Deterministic defined-term extraction. The model never edits the ledger.

export interface LedgerEntry {
  term: string;
  definition: string;
  itemId: string;
}

export const MAX_TERM_CHARS = 60;
export const MAX_DEFINITION_CHARS = 300;

const PARENTHETICAL = /\(\s*(?:the\s+)?["“]([^"”\n]{1,60})["”]\s*\)/g;
const MEANS = /["“]([^"”\n]{1,60})["”]\s+(?:means|shall mean|shall have the meaning)\b/gi;
const BARE = /(?:^|[.;:]\s+)([A-Z][A-Za-z0-9 &'-]{1,40})\s+(?:means|shall mean)\b/g;

function sentenceAt(text: string, index: number, end: number): string {
  let start = index;
  while (start > 0 && !/[.!?\n;]/.test(text[start - 1])) start--;
  let stop = end;
  while (stop < text.length && !/[.!?\n]/.test(text[stop])) stop++;
  return text.slice(start, Math.min(stop + 1, text.length));
}

function definitionAfter(text: string, end: number): string {
  let stop = end;
  while (stop < text.length && !/[.!?\n]/.test(text[stop])) stop++;
  return text.slice(end, Math.min(stop + 1, text.length));
}

export function extractDefinitions(text: string, itemId: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  const add = (termRaw: string, definitionRaw: string) => {
    const term = termRaw.replace(/\s+/g, ' ').trim();
    const definition = definitionRaw.replace(/\s+/g, ' ').trim().slice(0, MAX_DEFINITION_CHARS);
    if (!term || term.length > MAX_TERM_CHARS || !definition) return;
    if (entries.some((entry) => entry.term.toLowerCase() === term.toLowerCase())) return;
    entries.push({ term, definition, itemId });
  };

  for (const match of text.matchAll(PARENTHETICAL)) {
    const start = match.index ?? 0;
    add(match[1], sentenceAt(text, start, start + match[0].length));
  }
  for (const match of text.matchAll(MEANS)) {
    add(match[1], definitionAfter(text, (match.index ?? 0) + match[0].length));
  }
  for (const match of text.matchAll(BARE)) {
    add(match[1], definitionAfter(text, (match.index ?? 0) + match[0].length));
  }
  return entries;
}

export function mergeLedger(ledger: LedgerEntry[], entries: LedgerEntry[]): LedgerEntry[] {
  const merged = [...ledger];
  for (const entry of entries) {
    if (!merged.some((current) => current.term.toLowerCase() === entry.term.toLowerCase())) {
      merged.push(entry);
    }
  }
  return merged;
}

export function ledgerContext(ledger: LedgerEntry[]): string {
  return ledger.map((entry) => `- "${entry.term}": ${entry.definition}`).join('\n');
}

export function ledgerFromClauses(
  clauses: Record<string, ClauseRecord>,
  items: OutlineItem[],
): LedgerEntry[] {
  let ledger: LedgerEntry[] = [];
  for (const item of items) {
    const record = clauses[item.id];
    if (!record || (record.status !== 'done' && record.status !== 'verbatim')) continue;
    ledger = mergeLedger(ledger, extractDefinitions(record.text, item.id));
  }
  return ledger;
}
