import { describe, it, expect } from 'vitest';
import type { AnalysisChunk } from './analysisChunks';
import { evidenceChunkIndexes, rankEvidenceChunks, reportPromptAnswers, selectEvidenceChunks } from './promptEvidence';
import type { VerifiedClause } from './types';

const chunk = (index: number, pageStart: number, pageEnd: number, text = ''): AnalysisChunk => ({
  index,
  text: '',
  pageMarkedText: text,
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

const chunks = [
  chunk(0, 1, 2, 'The lessor and the lessee agree on the rent.'),
  chunk(1, 3, 4, 'The security deposit is refundable within sixty days.'),
  chunk(2, 5, 6, 'The tenant must give notice before vacating.'),
  chunk(3, 7, 8, 'Stamp duty is paid by the lessee.'),
];

describe('coverage evidence selection', () => {
  it('ranks the chunks a search hit touches, best first', () => {
    const ranked = rankEvidenceChunks(chunks, [
      { pageStart: 7, pageEnd: 8, fused: 0.03 },
      { pageStart: 3, pageEnd: 4, fused: 0.09 },
      { pageStart: 3, pageEnd: 3, fused: 0.01 },
    ]);
    expect(ranked.map((r) => r.index)).toEqual([1, 3]);
    expect(ranked[0].score).toBeCloseTo(0.1);
  });

  it('adds sections that mention the request terms, in document order, without duplicates', () => {
    const selection = selectEvidenceChunks(
      chunks,
      [{ pageStart: 7, pageEnd: 8, fused: 0.03 }],
      'List all security deposit terms, deposit amount and deposit refund',
      10,
    );
    expect(selection.indexes).toEqual([1, 3]);
    expect(selection.more).toBe(0);

    const both = selectEvidenceChunks(chunks, [{ pageStart: 5, pageEnd: 6, fused: 0.03 }], 'notice or deposit', 10);
    expect(both.indexes).toEqual([1, 2]);
  });

  it('reports the matching sections the cap left unread', () => {
    const selection = selectEvidenceChunks(
      chunks,
      [
        { pageStart: 1, pageEnd: 2, fused: 0.9 },
        { pageStart: 3, pageEnd: 4, fused: 0.8 },
      ],
      'security deposit and notice',
      1,
    );
    expect(selection.indexes).toEqual([0]);
    // "notice" is a generic word, so only the deposit section matched by text: one left unread.
    expect(selection.more).toBe(1);
  });

  it('reads nothing when the cap is zero or the request has no terms and no hits', () => {
    expect(selectEvidenceChunks(chunks, [], 'What is this?', 0)).toEqual({ indexes: [], more: 0 });
    expect(selectEvidenceChunks(chunks, [], '', 10)).toEqual({ indexes: [], more: 0 });
  });
});

describe('retry evidence reuse', () => {
  it('collects the chunk indexes of an earlier coverage pass', () => {
    expect(evidenceChunkIndexes(['r:ps', 'r:c3', 'r:cx5', 'r:c3/a', 'r:a2', 'r:ov'])).toEqual([3, 5]);
  });
});

describe('report findings as evidence', () => {
  const clause = (over: Partial<VerifiedClause> & { itemId: string; clauseNo: string }): VerifiedClause => ({
    type: 'obligation', summary: '', chunkId: 'analysis:0', chunkIndex: 0, pageStart: 1, pageEnd: 1,
    obligations: [], dates: [], payments: [], risks: [], verifiedItems: 0, ...over,
  });

  it('offers verified risks first, then obligations, payments and dates, each with its quote', () => {
    const out = reportPromptAnswers({
      clauses: [
        clause({
          itemId: 'c1',
          clauseNo: '4',
          risks: [
            { itemId: 'r1', clause: '4', text: 'The deposit is forfeited on any breach.', severity: 'high', page: 6, quote: 'The security deposit shall stand forfeited.', verified: true, applicability: 'unverified' },
          ],
          obligations: [
            { itemId: 'o1', clause: '4', party: 'Licensee', text: 'Pay the deposit.', page: 6, quote: 'The Licensee shall pay the security deposit.', verified: true },
          ],
          payments: [
            { itemId: 'p1', clause: '4', amount: 'Rs. 5,00,000', purpose: 'security deposit', payer: 'Licensee', payee: 'Licensor', due: 'on signing', page: 6, quote: 'The Licensee shall pay Rs. 5,00,000 as security deposit.', verified: true },
          ],
          dates: [
            { itemId: 'd1', clause: '4', text: '1 May 2026', purpose: 'commencement', timing_type: 'fixed', page: 6, quote: 'This Agreement commences on 1 May 2026.', verified: true },
          ],
        }),
      ],
    });
    expect(out.answers.map((a) => a.why)).toEqual([
      'risk finding (high)',
      'obligation of Licensee',
      'Licensee to Licensor',
      'commencement',
    ]);
    expect(out.answers.map((a) => a.itemId)).toEqual(['PR1', 'PR2', 'PR3', 'PR4']);
    for (const a of out.answers) {
      expect(a.verified).toBe(true);
      expect(a.quote.length).toBeGreaterThan(0);
      expect(a.clause).toBe('4');
    }
    expect(out.more).toBe(0);
  });

  it('keeps a page-and-quote duplicate once and reports the cap', () => {
    const risk = {
      itemId: 'r1', clause: '4', text: 'Risk.', severity: 'medium' as const, page: 6,
      quote: 'The security deposit shall stand forfeited.', verified: true as const, applicability: 'unverified' as const,
    };
    const out = reportPromptAnswers({
      clauses: [
        clause({ itemId: 'c1', clauseNo: '4', risks: [risk] }),
        clause({ itemId: 'c2', clauseNo: '5', risks: [{ ...risk, itemId: 'r2' }] }),
      ],
      limit: 1,
    });
    expect(out.answers).toHaveLength(1);
    expect(out.more).toBe(0);
    const capped = reportPromptAnswers({
      clauses: [
        clause({ itemId: 'c1', clauseNo: '4', risks: [risk, { ...risk, itemId: 'r3', page: 7, quote: 'A second risk quote.' }] }),
      ],
      limit: 1,
    });
    expect(capped.answers).toHaveLength(1);
    expect(capped.more).toBe(1);
  });
});
