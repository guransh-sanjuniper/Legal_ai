export interface LedgerChunkInput {
  chunkId: string;
  index: number;
  pageStart: number;
  pageEnd: number;
  processed: boolean;
  detectedClauses: string[];
  analysedClauses: string[];
  verifiedClauses: string[];
  skippedClauses?: string[];
  itemsAnalysed: number;
  itemsVerified: number;
}

export interface LedgerClause {
  clause: string;
  analysed: boolean;
  verified: boolean;
}

export interface LedgerChunk {
  chunkId: string;
  index: number;
  pages: [number, number];
  processed: boolean;
  detected: number;
  analysed: number;
  verified: number;
  skipped: string[];
  clauses: LedgerClause[];
  itemsAnalysed: number;
  itemsVerified: number;
}

export interface Ledger {
  chunks: LedgerChunk[];
  totals: {
    chunks: number;
    chunksProcessed: number;
    clausesDetected: number;
    clausesAnalysed: number;
    clausesVerified: number;
    clausesSkipped: number;
    itemsAnalysed: number;
    itemsVerified: number;
    citedPages: number[];
  };
}

// The ledger is built only from tasks that finished and from verified results, so its
// counts cannot claim more than actually happened.
export function buildLedger(entries: LedgerChunkInput[]): Ledger {
  const chunks: LedgerChunk[] = entries.map((e) => {
    const detected = [...new Set(e.detectedClauses)];
    const analysed = new Set(e.analysedClauses);
    const verified = new Set(e.verifiedClauses);
    return {
      chunkId: e.chunkId,
      index: e.index,
      pages: [e.pageStart, e.pageEnd],
      processed: e.processed,
      detected: detected.length,
      analysed: [...analysed].filter((c) => detected.includes(c)).length,
      verified: [...verified].filter((c) => detected.includes(c)).length,
      skipped: (e.skippedClauses ?? []).filter((c) => detected.includes(c) && !analysed.has(c)),
      clauses: detected.map((clause) => ({
        clause,
        analysed: analysed.has(clause),
        verified: verified.has(clause),
      })),
      itemsAnalysed: e.itemsAnalysed,
      itemsVerified: e.itemsVerified,
    };
  });

  const totals = {
    chunks: chunks.length,
    chunksProcessed: chunks.filter((c) => c.processed).length,
    clausesDetected: chunks.reduce((n, c) => n + c.detected, 0),
    clausesAnalysed: chunks.reduce((n, c) => n + c.analysed, 0),
    clausesVerified: chunks.reduce((n, c) => n + c.verified, 0),
    clausesSkipped: chunks.reduce((n, c) => n + c.skipped.length, 0),
    itemsAnalysed: chunks.reduce((n, c) => n + c.itemsAnalysed, 0),
    itemsVerified: chunks.reduce((n, c) => n + c.itemsVerified, 0),
    citedPages: [] as number[],
  };
  return { chunks, totals };
}

export function ledgerSummary(ledger: Ledger): string {
  const t = ledger.totals;
  return `${t.clausesAnalysed} of ${t.clausesDetected} clauses analysed, ${t.clausesVerified} verified, in ${t.chunksProcessed} of ${t.chunks} chunks`;
}
