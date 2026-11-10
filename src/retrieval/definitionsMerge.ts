export interface DefinitionItem {
  kind: 'party' | 'term' | 'date';
  name?: string;
  term?: string;
  definition?: string;
  clause?: string | null;
  page?: number | null;
  date?: string;
  description?: string;
}

export interface DefinitionsSheet {
  parties: string[];
  defined_terms: { term: string; definition: string; clause: string | null; page: number | null }[];
  key_dates: { date: string; description: string; clause: string | null; page: number | null }[];
  sources: { chunkId: string; pageStart: number; pageEnd: number }[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[“”"']/g, '');

export function isValidDefinitionItem(x: unknown): x is DefinitionItem {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (o.kind === 'party') return typeof o.name === 'string' && o.name.trim().length > 0;
  if (o.kind === 'term') return typeof o.term === 'string' && typeof o.definition === 'string' && o.term.trim().length > 0;
  if (o.kind === 'date') return typeof o.date === 'string' && o.date.trim().length > 0;
  return false;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Merges per-chunk model output into one sheet, deduplicating by normalised name/term/date
// and keeping the first clause/page where each was seen.
export function mergeDefinitions(
  items: DefinitionItem[],
  sources: { chunkId: string; pageStart: number; pageEnd: number }[] = [],
): DefinitionsSheet {
  const parties: string[] = [];
  const terms: DefinitionsSheet['defined_terms'] = [];
  const dates: DefinitionsSheet['key_dates'] = [];
  const seenParty = new Set<string>();
  const seenTerm = new Set<string>();
  const seenDate = new Set<string>();

  for (const item of items) {
    if (!isValidDefinitionItem(item)) continue;
    const clause = str(item.clause) || null;
    const page = num(item.page);
    if (item.kind === 'party') {
      const name = str(item.name);
      const key = norm(name);
      if (key && !seenParty.has(key)) {
        seenParty.add(key);
        parties.push(name);
      }
    } else if (item.kind === 'term') {
      const term = str(item.term);
      const key = norm(term);
      if (key && !seenTerm.has(key)) {
        seenTerm.add(key);
        terms.push({ term, definition: str(item.definition), clause, page });
      }
    } else {
      const date = str(item.date);
      const description = str(item.description);
      const key = `${norm(date)}|${norm(description)}`;
      if (date && !seenDate.has(key)) {
        seenDate.add(key);
        dates.push({ date, description, clause, page });
      }
    }
  }

  return { parties, defined_terms: terms, key_dates: dates, sources };
}
