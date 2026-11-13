import { describe, it, expect } from 'vitest';
import { rankChunksForPrompt } from './promptOnReport';
import type { AnalysisChunk } from './analysisChunks';

const chunk = (index: number, pageStart: number, pageEnd: number): AnalysisChunk => ({
  index,
  text: '',
  pageMarkedText: '',
  pageStart,
  pageEnd,
  clauseFrom: null,
  clauseTo: null,
  clauses: [],
  manifest: [],
  mode: 'structure',
  modeReason: '',
  sectionBreak: false,
  unusuallyLong: false,
});

describe('post-report prompt retrieval', () => {
  it('ranks the chunks that search hits touch, best first, without duplicates', () => {
    const chunks = [chunk(0, 1, 1), chunk(1, 2, 3), chunk(2, 4, 5)];
    const ranked = rankChunksForPrompt(chunks, [
      { pageStart: 4, pageEnd: 5, fused: 0.05 },
      { pageStart: 2, pageEnd: 2, fused: 0.02 },
      { pageStart: 2, pageEnd: 3, fused: 0.01 },
    ]);
    expect(ranked.map((r) => r.index)).toEqual([2, 1]);
    expect(ranked[1].score).toBeCloseTo(0.03);
  });

  it('returns nothing when no hit overlaps a chunk', () => {
    expect(rankChunksForPrompt([chunk(0, 1, 1)], [{ pageStart: 9, pageEnd: 9, fused: 0.02 }])).toEqual([]);
  });
});
