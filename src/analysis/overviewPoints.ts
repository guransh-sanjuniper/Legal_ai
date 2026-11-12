import { OVERVIEW_POINTS, STATUTORY_POINT } from './prompts';
import { keepCitedSentences, type KeptSentence } from './rollup';
import type { MissingProtection, OverviewPoint, RollupSentence, VerifiedClause } from './types';

export interface LawEngaged {
  name: string;
  clauses: string[];
  itemIds: string[];
}

// Act names from the risk items and missing-protection items. Counted once per name, case-insensitive.
export function lawsEngaged(clauses: VerifiedClause[], missing: MissingProtection[]): LawEngaged[] {
  const map = new Map<string, LawEngaged>();
  const add = (name: string, clause: string | null, itemId: string) => {
    const key = name.toLowerCase();
    const entry = map.get(key) ?? { name, clauses: [], itemIds: [] };
    if (clause && !entry.clauses.includes(clause)) entry.clauses.push(clause);
    if (!entry.itemIds.includes(itemId)) entry.itemIds.push(itemId);
    map.set(key, entry);
  };
  for (const c of clauses) {
    for (const r of c.risks) for (const name of r.laws ?? []) add(name, c.clauseNo, r.itemId);
  }
  for (const m of missing) for (const name of m.laws) add(name, null, m.itemId);
  return [...map.values()].sort((a, b) => b.itemIds.length - a.itemIds.length || a.name.localeCompare(b.name));
}

// Point 11 is built from the laws engaged. Each law is labelled as model knowledge, with no page.
export function statutorySentences(laws: LawEngaged[]): RollupSentence[] {
  if (laws.length === 0) return [{ text: 'No Act was named for the analysed clauses.', cites: [] }];
  return laws.map((law) => {
    const where = law.clauses.length ? `, engaged by clause ${law.clauses.join(', ')}` : '';
    return {
      text: `${law.name} (model knowledge, applicability unverified)${where}.`,
      cites: law.itemIds,
    };
  });
}

export interface ModelPointSentence {
  point: number;
  text: string;
  cites: string[];
}

// Keeps only sentences whose point is a model-written point and whose cites are valid.
export function keepPointSentences(
  items: unknown[],
  validIds: Set<string>,
): { kept: ModelPointSentence[]; dropped: number } {
  const kept: ModelPointSentence[] = [];
  let dropped = 0;
  for (const raw of items) {
    const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const point = typeof o.point === 'number' ? o.point : NaN;
    const valid = Number.isInteger(point) && point >= 1 && point <= OVERVIEW_POINTS.length && point !== STATUTORY_POINT;
    if (!valid) {
      dropped++;
      continue;
    }
    const sentence = keepCitedSentences([o as { text?: unknown; cites?: unknown }], validIds);
    if (sentence.kept.length === 0) {
      dropped += sentence.dropped;
      continue;
    }
    for (const k of sentence.kept as KeptSentence[]) kept.push({ point, text: k.text, cites: k.cites });
  }
  return { kept, dropped };
}

export function assembleOverviewPoints(modelSentences: ModelPointSentence[], statutory: RollupSentence[]): OverviewPoint[] {
  return OVERVIEW_POINTS.map((title, i) => {
    const point = i + 1;
    const sentences =
      point === STATUTORY_POINT
        ? statutory
        : modelSentences.filter((s) => s.point === point).map((s) => ({ text: s.text, cites: s.cites }));
    return { point, title, sentences };
  });
}
