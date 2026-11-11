import { buildUnits, documentStrict } from '../ingest/chunk';
import { chunkDocumentWithConfidence } from '../ingest/chunkQuality';

// Analysis runs on smaller pieces than embedding/retrieval chunks.
export const ANALYSIS_CHUNK_CONFIG = { targetTokens: 700, maxTokens: 1200, minTokens: 250 };

export interface AnalysisChunk {
  index: number;
  text: string;
  pageMarkedText: string;
  pageStart: number;
  pageEnd: number;
  clauseFrom: string | null;
  clauseTo: string | null;
  clauses: string[];
  manifest: string[];
  mode: 'structure' | 'structure-free';
  modeReason: string;
  sectionBreak: boolean;
  unusuallyLong: boolean;
}

export function buildAnalysisChunks(
  pages: Map<number, string>,
  opts: { inputLimit?: number } = {},
): AnalysisChunk[] {
  const pageTexts = [...pages.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageNo, text]) => ({ pageNo, text }));
  // Numbering style is decided for the whole document, so each piece reads it the same way.
  const strict = documentStrict(pageTexts);
  const result = chunkDocumentWithConfidence(pageTexts, ANALYSIS_CHUNK_CONFIG, {
    inputLimit: opts.inputLimit ?? 100_000,
  });
  return result.chunks.map((c) => {
    const units = buildUnits([{ pageNo: c.pageStart, text: c.text }], { strict });
    // In structure-free mode the model's clause numbers are not a manifest. Keep it empty so
    // coverage and retries are measured by chunks and pages instead.
    const manifest =
      result.mode === 'structure-free'
        ? []
        : [...new Set(units.map((u) => u.clauseNo).filter((x): x is string => x !== null))];
    return {
      index: c.index,
      text: c.text,
      pageMarkedText: c.pageMarkedText,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      clauseFrom: result.mode === 'structure-free' ? null : c.clauseFrom,
      clauseTo: result.mode === 'structure-free' ? null : c.clauseTo,
      clauses: result.mode === 'structure-free' ? [] : c.clauses,
      manifest,
      mode: result.mode,
      modeReason: result.modeReason,
      sectionBreak: c.sectionBreak,
      unusuallyLong: c.unusuallyLong,
    };
  });
}
