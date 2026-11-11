import { describe, it, expect } from 'vitest';
import { buildLedger, ledgerSummary } from './ledger';

const entries = [
  {
    chunkId: 'd:0',
    index: 0,
    pageStart: 1,
    pageEnd: 3,
    processed: true,
    detectedClauses: ['1', '2', '3'],
    analysedClauses: ['1', '2'],
    verifiedClauses: ['1'],
    skippedClauses: ['3'],
    itemsAnalysed: 6,
    itemsVerified: 2,
  },
  {
    chunkId: 'd:1',
    index: 1,
    pageStart: 4,
    pageEnd: 6,
    processed: false,
    detectedClauses: ['4', '5'],
    analysedClauses: [],
    verifiedClauses: [],
    itemsAnalysed: 0,
    itemsVerified: 0,
  },
];

describe('coverage ledger', () => {
  it('counts processed, analysed and verified per chunk and clause', () => {
    const ledger = buildLedger(entries);
    expect(ledger.chunks[0]).toMatchObject({ detected: 3, analysed: 2, verified: 1, processed: true, skipped: ['3'] });
    expect(ledger.chunks[1]).toMatchObject({ detected: 2, analysed: 0, verified: 0, processed: false });
    expect(ledger.chunks[0].clauses).toEqual([
      { clause: '1', analysed: true, verified: true },
      { clause: '2', analysed: true, verified: false },
      { clause: '3', analysed: false, verified: false },
    ]);
  });

  it('totals only what really happened', () => {
    const t = buildLedger(entries).totals;
    expect(t).toMatchObject({
      chunks: 2,
      chunksProcessed: 1,
      clausesDetected: 5,
      clausesAnalysed: 2,
      clausesVerified: 1,
      clausesSkipped: 1,
      itemsAnalysed: 6,
      itemsVerified: 2,
    });
    expect(ledgerSummary(buildLedger(entries))).toContain('2 of 5 clauses analysed');
  });

  it('ignores analysed or verified clauses that were never detected', () => {
    const l = buildLedger([
      {
        chunkId: 'd:0',
        index: 0,
        pageStart: 1,
        pageEnd: 1,
        processed: true,
        detectedClauses: ['1'],
        analysedClauses: ['1', 'ghost'],
        verifiedClauses: ['ghost'],
        itemsAnalysed: 1,
        itemsVerified: 1,
      },
    ]);
    expect(l.chunks[0].analysed).toBe(1);
    expect(l.chunks[0].verified).toBe(0);
  });
});
