export type PartyRole = 'party_to_agreement' | 'mentioned';

export interface PartyRef {
  name: string;
  role: PartyRole;
}

export interface DefinitionItem {
  kind: 'party' | 'term' | 'date';
  name?: string;
  role?: PartyRole;
  term?: string;
  definition?: string;
  clause?: string | null;
  page?: number | null;
  date?: string;
  description?: string;
}

export interface DefinitionsSheet {
  parties: PartyRef[];
  defined_terms: { term: string; definition: string; clause: string | null; page: number | null }[];
  key_dates: { date: string; description: string; clause: string | null; page: number | null }[];
  sources: { chunkId: string; pageStart: number; pageEnd: number }[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[“”"']/g, '');

export function isValidDefinitionItem(x: unknown): x is DefinitionItem {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (o.kind === 'party') {
    if (typeof o.name !== 'string' || o.name.trim().length === 0) return false;
    return o.role === undefined || o.role === 'party_to_agreement' || o.role === 'mentioned';
  }
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
  const parties: PartyRef[] = [];
  const terms: DefinitionsSheet['defined_terms'] = [];
  const dates: DefinitionsSheet['key_dates'] = [];
  const seenParty = new Map<string, PartyRef>();
  const seenTerm = new Set<string>();
  const seenDate = new Set<string>();

  for (const item of items) {
    if (!isValidDefinitionItem(item)) continue;
    const clause = str(item.clause) || null;
    const page = num(item.page);
    if (item.kind === 'party') {
      const name = str(item.name);
      const key = norm(name);
      const role: PartyRole = item.role === 'party_to_agreement' ? 'party_to_agreement' : 'mentioned';
      if (!key) continue;
      const existing = seenParty.get(key);
      if (!existing) {
        const ref: PartyRef = { name, role };
        seenParty.set(key, ref);
        parties.push(ref);
      } else if (role === 'party_to_agreement') {
        // A later, stronger classification wins.
        existing.role = 'party_to_agreement';
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

// Sheets stored before roles existed carried plain party names.
export function normalizeSheetParties(sheet: DefinitionsSheet): DefinitionsSheet {
  const parties = (sheet.parties as unknown[]).map((p) =>
    typeof p === 'string' ? { name: p, role: 'party_to_agreement' as PartyRole } : (p as PartyRef),
  );
  return { ...sheet, parties };
}
