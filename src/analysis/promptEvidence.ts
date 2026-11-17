import type { AnalysisChunk } from './analysisChunks';
import { significantTerms } from './questionTerms';

// Picks the extra sections the Deep Analysis coverage pass reads for a broad or list-type request.
// Search hits come first (best first), then sections whose text contains one of the request's own
// significant terms. Pure: the caller supplies the hits and the cap. No model call.

const PREFIX = 6;
const prefix = (w: string) => w.slice(0, PREFIX);

export interface EvidenceHit {
  pageStart: number;
  pageEnd: number;
  fused: number;
}

export interface EvidenceSelection {
  // Chunk indexes to read, in document order.
  indexes: number[];
  // Matching sections left unread because of the cap. Shown, never hidden.
  more: number;
}

// Chunks a search hit touches, scored by the hit's fused score (best first).
export function rankEvidenceChunks(chunks: AnalysisChunk[], hits: EvidenceHit[]): { index: number; score: number }[] {
  const scores = new Map<number, number>();
  for (const hit of hits) {
    for (const c of chunks) {
      if (c.pageEnd < hit.pageStart || c.pageStart > hit.pageEnd) continue;
      scores.set(c.index, (scores.get(c.index) ?? 0) + hit.fused);
    }
  }
  return [...scores.entries()]
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

export function selectEvidenceChunks(
  chunks: AnalysisChunk[],
  hits: EvidenceHit[],
  request: string,
  limit: number,
): EvidenceSelection {
  if (limit <= 0) return { indexes: [], more: 0 };
  const terms = significantTerms(request).map(prefix);
  const byIndex = new Map(chunks.map((c) => [c.index, c]));
  const candidates: number[] = [];
  const seen = new Set<number>();
  for (const r of rankEvidenceChunks(chunks, hits)) {
    if (seen.has(r.index) || !byIndex.has(r.index)) continue;
    seen.add(r.index);
    candidates.push(r.index);
  }
  if (terms.length > 0) {
    for (const chunk of chunks) {
      if (seen.has(chunk.index)) continue;
      const have = new Set(
        chunk.pageMarkedText
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean)
          .map(prefix),
      );
      if (!terms.some((t) => have.has(t))) continue;
      seen.add(chunk.index);
      candidates.push(chunk.index);
    }
  }
  const chosen = candidates.slice(0, limit).sort((a, b) => a - b);
  return { indexes: chosen, more: Math.max(0, candidates.length - chosen.length) };
}

// On a retry, the sections the earlier attempt read are reused from its stored tasks, so a re-run
// does not search again or read a different set.
export function evidenceChunkIndexes(taskIds: string[]): number[] {
  const out = new Set<number>();
  for (const id of taskIds) {
    const suffix = id.slice(id.lastIndexOf(':') + 1).split('/')[0];
    const m = /^cx?(\d+)$/.exec(suffix);
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}
