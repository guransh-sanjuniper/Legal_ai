import { RRF_K } from './config';

export interface Ranked {
  id: string;
  score: number;
}

// Reciprocal rank fusion. Each list is ranked best-first; RRF uses only ranks, so a
// cosine list and a keyword list can be combined without score calibration.
export function rrfFuse(lists: Ranked[][], k = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, index) => {
      fused.set(item.id, (fused.get(item.id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return fused;
}

// Sorted best-first, with a stable tiebreak on id.
export function rankedFusion(lists: Ranked[][], k = RRF_K): Ranked[] {
  return [...rrfFuse(lists, k).entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

// Drops results that are far below the best score, so weak matches are not forced in.
export function filterWeak(results: Ranked[], ratio: number): Ranked[] {
  if (results.length === 0) return results;
  const top = results[0].score;
  return results.filter((r) => r.score >= top * ratio);
}
