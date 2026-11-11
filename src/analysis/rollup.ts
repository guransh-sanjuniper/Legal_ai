export interface CitedSentence {
  text?: unknown;
  cites?: unknown;
}

export interface KeptSentence {
  text: string;
  cites: string[];
}

// Groups items into batches of min-max size. A short tail is merged into the previous
// batch when that keeps the batch within max.
export function groupForRollup<T>(items: T[], min = 30, max = 60): T[][] {
  const n = items.length;
  if (n === 0) return [];
  if (n <= max) return [items.slice()];

  // Choose a group count that keeps every group within [min, max], then distribute evenly.
  const target = Math.round((min + max) / 2);
  let count = Math.max(1, Math.round(n / target));
  while (Math.ceil(n / count) > max) count++;
  while (count > 1 && Math.floor(n / count) < min) count--;

  const base = Math.floor(n / count);
  const extra = n % count;
  const groups: T[][] = [];
  let offset = 0;
  for (let g = 0; g < count; g++) {
    const size = base + (g < extra ? 1 : 0);
    groups.push(items.slice(offset, offset + size));
    offset += size;
  }
  return groups;
}

// A roll-up sentence must cite at least one ID that exists in the source items.
// Unknown cites are removed; sentences with no valid cite are dropped.
export function keepCitedSentences(
  sentences: CitedSentence[],
  validIds: Set<string>,
): { kept: KeptSentence[]; dropped: number } {
  const kept: KeptSentence[] = [];
  let dropped = 0;
  for (const s of sentences) {
    const text = typeof s.text === 'string' ? s.text.trim() : '';
    const raw = Array.isArray(s.cites) ? s.cites.filter((c): c is string => typeof c === 'string') : [];
    const cites = [...new Set(raw)].filter((c) => validIds.has(c));
    if (!text || cites.length === 0) {
      dropped++;
      continue;
    }
    kept.push({ text, cites });
  }
  return { kept, dropped };
}

// Overview length scales with the document: roughly one sentence per ten source items.
export function overviewTargetSentenceCount(sourceItems: number): number {
  return Math.max(5, Math.min(40, Math.ceil(sourceItems / 10)));
}
