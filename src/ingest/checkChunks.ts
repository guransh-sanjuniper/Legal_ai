import { DEFAULT_CHUNK_CONFIG, type Chunk, type ChunkConfig, type PageText } from './chunk';

export interface ChunkCheck {
  ok: boolean;
  pageCount: number;
  coveredPages: number;
  pageGaps: number[];
  pageOverlaps: number[];
  aboveMax: { index: number; tokenEst: number }[];
  aboveInputLimit: { index: number; tokenEst: number; limit: number }[];
  badStarts: { index: number; firstLine: string; reason: string }[];
  missingClauses: string[];
  repeatedClauses: string[];
  splitClauses: { clause: string; chunkIndexes: number[] }[];
  longClauses: { clause: string; pages: number; pageStart: number; pageEnd: number; tokenEst: number; chunkIndexes: number[] }[];
  repeatedRanges: { pageStart: number; pageEnd: number; count: number; chunkIndexes: number[] }[];
  sectionBreaks: { page: number; label: string }[];
  mode: 'structure' | 'structure-free';
  modeReason: string;
  chunkCount: number;
  longestChunkTokens: number;
  counts: {
    chunks: number;
    gaps: number;
    overlaps: number;
    aboveMax: number;
    aboveInputLimit: number;
    badStarts: number;
    missing: number;
    repeated: number;
    split: number;
    longClauses: number;
    repeatedRanges: number;
    sectionBreaks: number;
  };
}

export interface ChunkCheckOptions {
  mode?: 'structure' | 'structure-free';
  modeReason?: string;
  inputLimit?: number;
  maxClausePages?: number;
  repeatedRangeThreshold?: number;
}

// Page p may legitimately be shared by two consecutive chunks when one clause ends on
// page p and the next starts there, and parts of one split clause share the clause page range.
// Size-split parts share their group's page range, so a page may list them all.
// Collapse every part to the first chunk of its group before judging overlap.
function groupOf(chunks: Chunk[], i: number): number {
  const c = chunks[i];
  return c.split ? c.index - (c.partIndex ?? 0) : c.index;
}

function legitimateShare(owners: number[], chunks: Chunk[], p: number): boolean {
  const groups = [...new Set(owners.map((i) => groupOf(chunks, i)))].sort((a, b) => a - b);
  if (groups.length === 1) return true;
  if (groups.length !== 2) return false;
  const [a, b] = groups;
  const first = chunks[a];
  // For a size-split clause the shared page is the end of the last part, not the first part.
  const lastPart = a + ((first.partCount ?? 1) - 1);
  const A = chunks[lastPart] ?? first;
  const B = chunks[b];
  const adjacent = b === a + (A.partCount ?? 1);
  return adjacent && p === A.pageEnd && p === B.pageStart;
}

export function checkChunks(
  chunks: Chunk[],
  pages: PageText[],
  cfg: ChunkConfig = DEFAULT_CHUNK_CONFIG,
  opts: ChunkCheckOptions = {},
): ChunkCheck {
  const pageCount = pages.length > 0 ? Math.max(...pages.map((p) => p.pageNo)) : chunks.reduce((m, c) => Math.max(m, c.pageEnd), 0);
  const inputLimit = opts.inputLimit ?? 100_000;
  const maxClausePages = opts.maxClausePages ?? cfg.maxClausePages;
  const repeatedRangeThreshold = opts.repeatedRangeThreshold ?? 5;

  const claims = new Map<number, number[]>();
  chunks.forEach((c, i) => {
    for (let p = c.pageStart; p <= c.pageEnd; p++) {
      const list = claims.get(p) ?? [];
      list.push(i);
      claims.set(p, list);
    }
  });

  const pageGaps: number[] = [];
  const pageOverlaps: number[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const owners = claims.get(p);
    if (!owners || owners.length === 0) pageGaps.push(p);
    else if (owners.length > 1 && !legitimateShare(owners, chunks, p)) pageOverlaps.push(p);
  }

  const aboveMax = chunks.filter((c) => c.tokenEst > cfg.maxTokens).map((c) => ({ index: c.index, tokenEst: c.tokenEst }));
  const aboveInputLimit = chunks
    .filter((c) => c.tokenEst > inputLimit)
    .map((c) => ({ index: c.index, tokenEst: c.tokenEst, limit: inputLimit }));

  const badStarts: ChunkCheck['badStarts'] = [];
  for (const c of chunks) {
    const firstLine = c.text.split('\n')[0] ?? '';
    if (c.split) continue;
    if (c.clauseFrom !== null) {
      if (c.startKind === 'clause' && !/^\s*\d{1,3}\)/.test(firstLine) && !/^\s*\d{1,3}[.\s]/.test(firstLine) && !/^\s*(CLAUSE|Clause)\s/.test(firstLine)) {
        badStarts.push({ index: c.index, firstLine, reason: 'first line is not the claimed clause' });
      }
      continue;
    }
    const allowed = c.index === 0 || c.startKind === 'preamble' || c.startKind === 'lettered' || c.startKind === 'section' || c.startKind === 'free';
    if (!allowed) badStarts.push({ index: c.index, firstLine, reason: 'no clause and not a preamble/section start' });
  }

  const byClause = new Map<string, number[]>();
  for (const c of chunks) {
    for (const clause of c.clauses ?? []) {
      const list = byClause.get(clause) ?? [];
      list.push(c.index);
      byClause.set(clause, list);
    }
  }

  const numeric = [...byClause.keys()]
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b);

  const missingClauses: string[] = [];
  if (numeric.length > 0) {
    for (let n = numeric[0]; n <= numeric[numeric.length - 1]; n++) {
      if (!byClause.has(String(n))) missingClauses.push(String(n));
    }
  }

  const chunkByIndex = new Map(chunks.map((c) => [c.index, c]));

  const splitClauses: ChunkCheck['splitClauses'] = [];
  const repeatedClauses: string[] = [];
  for (const [clause, indexes] of byClause) {
    if (indexes.length < 2) continue;
    const allSplit = indexes.every((i) => chunkByIndex.get(i)?.split === true);
    if (allSplit) splitClauses.push({ clause, chunkIndexes: indexes });
    else repeatedClauses.push(clause);
  }
  splitClauses.sort((a, b) => Number(a.clause) - Number(b.clause));

  // Clause spans are aggregated over all its chunks, including size-split parts.
  const longClauses: ChunkCheck['longClauses'] = [];
  for (const [clause, indexes] of byClause) {
    const parts = indexes.map((i) => chunkByIndex.get(i)).filter((c): c is Chunk => c !== undefined);
    if (parts.length === 0) continue;
    const pageStart = Math.min(...parts.map((c) => c.pageStart));
    const pageEnd = Math.max(...parts.map((c) => c.pageEnd));
    const pages = pageEnd - pageStart + 1;
    const tokenEst = parts.reduce((n, c) => n + c.tokenEst, 0);
    if (pages > maxClausePages || parts.some((c) => c.unusuallyLong)) {
      longClauses.push({ clause, pages, pageStart, pageEnd, tokenEst, chunkIndexes: indexes });
    }
  }
  longClauses.sort((a, b) => b.pages - a.pages);

  const rangeGroups = new Map<string, number[]>();
  for (const c of chunks) {
    const key = `${c.pageStart}-${c.pageEnd}`;
    const list = rangeGroups.get(key) ?? [];
    list.push(c.index);
    rangeGroups.set(key, list);
  }
  const repeatedRanges: ChunkCheck['repeatedRanges'] = [];
  for (const [key, indexes] of rangeGroups) {
    if (indexes.length < repeatedRangeThreshold) continue;
    const [pageStart, pageEnd] = key.split('-').map(Number);
    repeatedRanges.push({ pageStart, pageEnd, count: indexes.length, chunkIndexes: indexes });
  }
  repeatedRanges.sort((a, b) => b.count - a.count);

  const sectionBreaks: ChunkCheck['sectionBreaks'] = [];
  const seenBreaks = new Set<string>();
  for (const c of chunks) {
    if (!c.sectionBreak) continue;
    const label = (c.heading ?? '').slice(0, 120);
    const key = `${c.pageStart}|${label}`;
    if (seenBreaks.has(key)) continue;
    seenBreaks.add(key);
    sectionBreaks.push({ page: c.pageStart, label });
  }

  const counts = {
    chunks: chunks.length,
    gaps: pageGaps.length,
    overlaps: pageOverlaps.length,
    aboveMax: aboveMax.length,
    aboveInputLimit: aboveInputLimit.length,
    badStarts: badStarts.length,
    missing: missingClauses.length,
    repeated: repeatedClauses.length,
    split: splitClauses.length,
    longClauses: longClauses.length,
    repeatedRanges: repeatedRanges.length,
    sectionBreaks: sectionBreaks.length,
  };

  return {
    ok:
      counts.gaps === 0 &&
      (opts.mode === 'structure-free' ? true : counts.overlaps === 0) &&
      counts.aboveMax === 0 &&
      counts.aboveInputLimit === 0 &&
      counts.badStarts === 0 &&
      counts.missing === 0 &&
      counts.repeated === 0 &&
      counts.longClauses === 0 &&
      counts.repeatedRanges === 0,
    pageCount,
    coveredPages: pageCount - pageGaps.length,
    pageGaps,
    pageOverlaps,
    aboveMax,
    aboveInputLimit,
    badStarts,
    missingClauses,
    repeatedClauses,
    splitClauses,
    longClauses,
    repeatedRanges,
    sectionBreaks,
    mode: opts.mode ?? 'structure',
    modeReason: opts.modeReason ?? '',
    chunkCount: chunks.length,
    longestChunkTokens: chunks.reduce((n, c) => Math.max(n, c.tokenEst), 0),
    counts,
  };
}
