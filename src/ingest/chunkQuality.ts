import {
  chunkDocument,
  resolveChunkConfig,
  structureFreeChunks,
  type Chunk,
  type ChunkConfig,
  type PageText,
} from './chunk';
import { checkChunks, type ChunkCheck } from './checkChunks';

export type ChunkMode = 'structure' | 'structure-free';

export interface ChunkingResult {
  chunks: Chunk[];
  mode: ChunkMode;
  modeReason: string;
  check: ChunkCheck;
  structureCheck: ChunkCheck;
  confidence: 'high' | 'low';
  reasons: string[];
}

function numericClauseCount(chunks: Chunk[]): number {
  const set = new Set<string>();
  for (const c of chunks) for (const clause of c.clauses) if (/^\d+$/.test(clause)) set.add(clause);
  return set.size;
}

function confidenceReasons(check: ChunkCheck, cfg: ChunkConfig): string[] {
  const reasons: string[] = [];
  if (check.pageGaps.length > 0) reasons.push(`${check.pageGaps.length} page gap(s)`);
  if (check.pageOverlaps.length > 0) reasons.push(`${check.pageOverlaps.length} unexplained page overlap(s)`);
  if (check.badStarts.length > 0) reasons.push(`${check.badStarts.length} bad chunk start(s)`);
  if (check.aboveMax.length > 0) reasons.push(`${check.aboveMax.length} chunk(s) above max size`);
  if (check.aboveInputLimit.length > 0) reasons.push(`${check.aboveInputLimit.length} chunk(s) above the model input limit`);
  if (check.missingClauses.length > 0) reasons.push(`${check.missingClauses.length} missing clause number(s)`);
  if (check.repeatedClauses.length > Math.max(2, Math.floor(check.chunkCount * 0.02)))
    reasons.push(`${check.repeatedClauses.length} repeated clause number(s)`);
  if (check.longClauses.length > 0) reasons.push(`${check.longClauses.length} clause(s) over ${cfg.maxClausePages} pages`);
  if (check.repeatedRanges.length > 0) reasons.push(`${check.repeatedRanges.length} page range(s) shared by many chunks`);

  return reasons;
}

// Builds structured chunks, checks them, and falls back to structure-free chunks when the
// structure is not trustworthy. The returned check describes the chosen mode.
export function chunkDocumentWithConfidence(
  pages: PageText[],
  overrides: Partial<ChunkConfig> = {},
  opts: { inputLimit?: number; repeatedRangeThreshold?: number } = {},
): ChunkingResult {
  const cfg = resolveChunkConfig(overrides);
  const structure = chunkDocument(pages, overrides);
  const structureCheck = checkChunks(structure, pages, cfg, {
    mode: 'structure',
    inputLimit: opts.inputLimit,
    repeatedRangeThreshold: opts.repeatedRangeThreshold,
  });

  const reasons = confidenceReasons(structureCheck, cfg);

  // Clause count plausibility: a 493-page document with one clause, or a 3-page document with
  // hundreds, usually means the structure detection collapsed.
  const pageCount = pages.length > 0 ? Math.max(...pages.map((p) => p.pageNo)) : 0;
  const clauseCount = numericClauseCount(structure);
  if (pageCount >= 20 && clauseCount < Math.max(1, Math.floor(pageCount / 100))) {
    reasons.push(`only ${clauseCount} clause number(s) for ${pageCount} pages`);
  }
  if (pageCount > 0 && clauseCount > pageCount * 5) {
    reasons.push(`${clauseCount} clause numbers for ${pageCount} pages`);
  }

  if (reasons.length === 0) {
    return {
      chunks: structure,
      mode: 'structure',
      modeReason: '',
      check: structureCheck,
      structureCheck,
      confidence: 'high',
      reasons,
    };
  }

  const free = structureFreeChunks(pages, {
    targetTokens: Math.min(1000, cfg.targetTokens),
    overlapTokens: 100,
    maxTokens: cfg.maxTokens,
  });
  const freeCheck = checkChunks(free, pages, cfg, {
    mode: 'structure-free',
    modeReason: reasons.join('; '),
    inputLimit: opts.inputLimit,
    repeatedRangeThreshold: opts.repeatedRangeThreshold,
  });
  return {
    chunks: free,
    mode: 'structure-free',
    modeReason: reasons.join('; '),
    check: freeCheck,
    structureCheck,
    confidence: 'low',
    reasons,
  };
}
