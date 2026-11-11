import { buildUnits, chunkDocument } from '../ingest/chunk';

// Analysis runs on smaller pieces than embedding/retrieval chunks.
export const ANALYSIS_CHUNK_CONFIG = { targetTokens: 700, maxTokens: 1200, minTokens: 250 };

export interface AnalysisChunk {
  index: number;
  text: string;
  pageStart: number;
  pageEnd: number;
  clauseFrom: string | null;
  clauseTo: string | null;
  clauses: string[];
  manifest: string[];
}

export function buildAnalysisChunks(pages: Map<number, string>): AnalysisChunk[] {
  const pageTexts = [...pages.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageNo, text]) => ({ pageNo, text }));
  return chunkDocument(pageTexts, ANALYSIS_CHUNK_CONFIG).map((c) => {
    const units = buildUnits([{ pageNo: c.pageStart, text: c.text }]);
    const manifest = [...new Set(units.map((u) => u.clauseNo).filter((x): x is string => x !== null))];
    return {
      index: c.index,
      text: c.text,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      clauseFrom: c.clauseFrom,
      clauseTo: c.clauseTo,
      clauses: c.clauses,
      manifest,
    };
  });
}
