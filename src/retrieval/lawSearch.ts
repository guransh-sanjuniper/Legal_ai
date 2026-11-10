import MiniSearch from 'minisearch';
import law from './law/law_standin.json';
import { tokenize } from './tokenize';
import { LAW_STANDIN_VERSION } from './config';

export interface LawPassage {
  id: string;
  title: string;
  text: string;
}

export const LAW_PASSAGES: LawPassage[] = law.passages;
export const LAW_NOTICE = law.notice;
export const LAW_VERSION = LAW_STANDIN_VERSION;

let index: MiniSearch<LawPassage> | null = null;

export function lawIndex(): MiniSearch<LawPassage> {
  if (index) return index;
  const ms = new MiniSearch<LawPassage>({
    fields: ['title', 'text'],
    storeFields: ['title', 'text'],
    tokenize,
    searchOptions: { tokenize, prefix: true, fuzzy: 0.1, boost: { title: 2 } },
  });
  ms.addAll(LAW_PASSAGES.map((p) => ({ ...p, id: p.id })));
  index = ms;
  return ms;
}

export interface LawHit {
  id: string;
  title: string;
  text: string;
  score: number;
}

// Keyword-only law search. The worker also ranks law passages by embedding; this function
// is the deterministic fallback and is unit-tested against known clauses.
export function lawSearchKeyword(clauseText: string, k = 3): LawHit[] {
  return lawIndex()
    .search(clauseText)
    .slice(0, k)
    .map((r) => ({ id: r.id, title: r.title as string, text: r.text as string, score: r.score }));
}

// Public name used by callers. The worker also adds vector ranking on top of this.
export const lawSearch = lawSearchKeyword;
