import path from 'node:path';
import { describe, it, expect } from 'vitest';
import planted from './planted.json';
import type { GoldenFile } from '../../src/analysis/goldenScore';
import type { AnalysisReport, VerifiedClause } from '../../src/analysis/types';
import { scoreDocument } from '../../src/quality/score';
import { extractPages } from './extract';

const PDF = path.join(process.cwd(), 'tests/fixtures/planted.pdf');
const golden = planted as GoldenFile;

describe('planted-fact document', () => {
  it('writes facts on the pages and clauses recorded in the golden file', async () => {
    const pages = await extractPages(PDF);
    expect(pages).toHaveLength(golden.pages!);
    const decoys = golden.expected.filter((e) => e.reason?.startsWith('DECOY'));

    for (const e of golden.expected) {
      const clause = Number(e.clause);
      const expectedPage = Math.floor((clause - 1) / 3) + 1;
      const found = pages[expectedPage - 1].text.split('\n').find((line) => line.includes(e.token));
      if (decoys.includes(e)) {
        expect(found, `decoy ${e.token} must not be planted`).toBeUndefined();
        continue;
      }
      expect(found, `planted ${e.kind} ${e.token} in clause ${clause}`).toBeDefined();
    }
  }, 60_000);

  it('scores a planted document without a model call and flags the decoy', async () => {
    const pages = await extractPages(PDF);
    const pageMap = new Map(pages.map((p) => [p.pageNo, p.text]));
    const byClause = new Map<string, VerifiedClause>();
    const decoyTokens = new Set(golden.expected.filter((e) => e.reason?.startsWith('DECOY')).map((e) => e.token));

    const clauseFor = (clauseNo: string, page: number): VerifiedClause => {
      const existing = byClause.get(clauseNo);
      if (existing) return existing;
      const created: VerifiedClause = {
        itemId: `C${clauseNo}`,
        clauseNo,
        type: 'other',
        summary: `Clause ${clauseNo}`,
        chunkId: 'analysis:0',
        chunkIndex: 0,
        pageStart: page,
        pageEnd: page,
        obligations: [],
        dates: [],
        payments: [],
        risks: [],
        verifiedItems: 0,
      };
      byClause.set(clauseNo, created);
      return created;
    };

    for (const e of golden.expected) {
      if (decoyTokens.has(e.token)) continue;
      const clause = Number(e.clause);
      const expectedPage = Math.floor((clause - 1) / 3) + 1;
      const line = pages[expectedPage - 1].text.split('\n').find((x) => x.includes(e.token));
      if (!line) continue;
      const found = { page: expectedPage, line };
      const c = clauseFor(e.clause, found.page);
      if (e.kind === 'payment') {
        c.payments.push({
          itemId: `${c.itemId}:p${c.payments.length}`,
          clause: e.clause,
          amount: e.token,
          payer: '',
          payee: '',
          due: '',
          page: found.page,
          quote: found.line,
          verified: true,
        });
      } else if (e.kind === 'date') {
        c.dates.push({
          itemId: `${c.itemId}:d${c.dates.length}`,
          clause: e.clause,
          text: e.token,
          timing_type: 'fixed',
          page: found.page,
          quote: found.line,
          verified: true,
        });
      } else if (e.kind === 'obligation') {
        c.obligations.push({
          itemId: `${c.itemId}:o${c.obligations.length}`,
          clause: e.clause,
          party: 'Developer',
          text: e.token,
          page: found.page,
          quote: found.line,
          verified: true,
        });
      } else if (e.kind === 'risk') {
        c.risks.push({
          itemId: `${c.itemId}:r${c.risks.length}`,
          clause: e.clause,
          text: e.token,
          severity: 'medium',
          page: found.page,
          quote: found.line,
          verified: true,
          lawPassages: [],
          applicability: 'unverified',
        });
      }
    }

    const clauses = [...byClause.values()];
    const items = clauses.reduce((n, c) => n + c.payments.length + c.dates.length + c.obligations.length + c.risks.length, 0);
    const report: AnalysisReport = {
      docId: 'planted',
      docHash: 'planted',
      docName: 'planted.pdf',
      runId: 'planted-run',
      createdAt: 0,
      model: 'fixture',
      lawVersion: 'standin-1',
      definitions: { parties: [], defined_terms: [], key_dates: [] },
      clauses,
      overview: [{ text: 'The agreement contains payment, date, obligation and penalty terms.', cites: [clauses[0].itemId] }],
      sections: [],
      crossClause: { findings: [], payments: [] },
      ledger: {
        chunks: [
          {
            chunkId: 'analysis:0',
            index: 0,
            pages: [1, golden.pages!],
            processed: true,
            detected: clauses.length,
            analysed: clauses.length,
            verified: clauses.length,
            skipped: [],
            clauses: clauses.map((c) => ({ clause: c.clauseNo, analysed: true, verified: true })),
            itemsAnalysed: items,
            itemsVerified: items,
          },
        ],
        totals: {
          chunks: 1,
          chunksProcessed: 1,
          clausesDetected: clauses.length,
          clausesAnalysed: clauses.length,
          clausesVerified: clauses.length,
          clausesSkipped: 0,
          itemsAnalysed: items,
          itemsVerified: items,
          citedPages: [],
        },
      },
      metrics: {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        p95DurationMs: 0,
        retried: 0,
        split: 0,
        failed: 0,
        emptyOutput: 0,
        totalTasks: 0,
        doneTasks: 0,
        p95CompletionTokens: 0,
        recommendedMaxTokens: null,
      },
      drops: [],
      amounts: { code: [], uncaptured: [] },
      resolution: { pageCorrected: 0, dropped: 0, skippedClauses: 0 },
      notices: [],
    };

    const score = scoreDocument({ report, golden, pages: pageMap });
    expect(score.quoteValidity.rate).toBe(1);
    expect(score.recall.payment.combinedMisses.map((m) => m.token)).toEqual(['9,99,999']);
    expect(score.pass).toBe(true);
  }, 60_000);
});
