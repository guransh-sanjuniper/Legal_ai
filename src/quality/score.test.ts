import { describe, it, expect } from 'vitest';
import type { AnalysisReport, VerifiedClause } from '../analysis/types';
import { goldenDocName, type GoldenFile } from '../analysis/goldenScore';
import type { Task } from '../tasks/types';
import hiramoti from '../../tests/golden/hiramoti.json';
import { aggregateScores, checkFalseMissing, checkOverview, checkQuoteValidity, scoreDocument } from './score';
import { compareRuns } from './repeat';
import { compareScores, loadHistory, previousScore, saveScore } from './history';

const PAGE_TEXT = new Map<number, string>([
  [1, '1. Payment\nThe Purchaser shall pay Rs. 1,00,000 to the Developer on or before 31 March 2027.'],
  [2, '2. Registration\nThe Purchaser shall register this agreement within 30 days.'],
  [3, '3. Penalty\nDelay attracts interest at 2 percent per month.'],
  [4, '4. Termination\nEither party may terminate on 60 days notice.\nDisputes shall be referred to arbitration.'],
  [5, '5. Notices\nNotices shall be in writing.'],
]);

function clause(overrides: Partial<VerifiedClause> & { clauseNo: string; itemId: string }): VerifiedClause {
  return {
    type: 'other',
    summary: '',
    chunkId: 'analysis:0',
    chunkIndex: 0,
    pageStart: 1,
    pageEnd: 5,
    obligations: [],
    dates: [],
    payments: [],
    risks: [],
    verifiedItems: 0,
    ...overrides,
  };
}

const CLAUSES: VerifiedClause[] = [
  clause({
    clauseNo: '1',
    itemId: 'C1',
    type: 'payment',
    summary: 'The purchaser pays the price by 31 March 2027.',
    payments: [
      {
        itemId: 'C1:p0',
        clause: '1',
        amount: 'Rs. 1,00,000',
        payer: 'Purchaser',
        payee: 'Developer',
        due: 'on or before 31 March 2027',
        page: 1,
        quote: 'The Purchaser shall pay Rs. 1,00,000 to the Developer on or before 31 March 2027',
        verified: true,
      },
    ],
    dates: [
      {
        itemId: 'C1:d0',
        clause: '1',
        text: '31 March 2027',
        timing_type: 'fixed',
        page: 1,
        quote: 'on or before 31 March 2027',
        verified: true,
      },
    ],
  }),
  clause({
    clauseNo: '2',
    itemId: 'C2',
    type: 'registration',
    summary: 'Registration within 30 days.',
    obligations: [
      {
        itemId: 'C2:o0',
        clause: '2',
        party: 'Purchaser',
        text: 'register this agreement within 30 days',
        page: 2,
        quote: 'The Purchaser shall register this agreement within 30 days',
        verified: true,
      },
    ],
    dates: [
      {
        itemId: 'C2:d0',
        clause: '2',
        text: 'within 30 days',
        timing_type: 'event_relative',
        page: 2,
        quote: 'within 30 days',
        verified: true,
      },
    ],
  }),
  clause({
    clauseNo: '3',
    itemId: 'C3',
    type: 'penalty',
    summary: 'Interest on delayed payment.',
    risks: [
      {
        itemId: 'C3:r0',
        clause: '3',
        text: 'interest at 2 percent per month',
        severity: 'medium',
        page: 3,
        quote: 'Delay attracts interest at 2 percent per month',
        verified: true,
        lawPassages: [],
        applicability: 'unverified',
      },
    ],
  }),
  clause({
    clauseNo: '4',
    itemId: 'C4',
    type: 'termination',
    summary: 'Either party may terminate on 60 days notice.',
    dates: [
      {
        itemId: 'C4:d0',
        clause: '4',
        text: '60 days notice',
        timing_type: 'event_relative',
        page: 4,
        quote: 'may terminate on 60 days notice',
        verified: true,
      },
    ],
  }),
];

const TASKS: Task[] = [
  {
    id: 'run-1:a0',
    runId: 'run-1',
    parentId: null,
    depth: 0,
    docHash: 'hash',
    prepFingerprint: 'fp',
    promptVersion: 'v',
    prompt: '',
    input: '',
    maxTokens: 100,
    fingerprint: 'f',
    status: 'done',
    attemptNo: 1,
    attemptId: 'a',
    model: 'test',
    nextAt: 0,
    failureCode: null,
    failureMessage: null,
    finishReason: 'stop',
    provider: 'p',
    promptTokens: 1,
    completionTokens: 1,
    durationMs: 1,
    rejectedItems: 0,
    updatedAt: 1,
  },
  {
    id: 'run-1:s0',
    runId: 'run-1',
    parentId: null,
    depth: 0,
    docHash: 'hash',
    prepFingerprint: 'fp',
    promptVersion: 'v',
    prompt: '',
    input: '',
    maxTokens: 100,
    fingerprint: 'f2',
    status: 'done',
    attemptNo: 1,
    attemptId: 'b',
    model: 'test',
    nextAt: 0,
    failureCode: null,
    failureMessage: null,
    finishReason: 'stop',
    provider: 'p',
    promptTokens: 1,
    completionTokens: 1,
    durationMs: 1,
    rejectedItems: 0,
    updatedAt: 1,
  },
];

function makeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  const report: AnalysisReport = {
    docId: 'doc-1',
    docHash: 'hash',
    docName: 'Synthetic agreement.pdf',
    runId: 'run-1',
    createdAt: 1_700_000_000_000,
    model: 'test-model',
    lawVersion: 'standin-1',
    definitions: { parties: [], defined_terms: [], key_dates: [] },
    clauses: CLAUSES,
    overview: [
      { text: 'The purchaser pays Rs. 1,00,000 by 31 March 2027.', cites: ['C1'] },
      { text: 'The registration obligation runs for 30 days.', cites: ['C2'] },
    ],
    sections: [
      {
        section: 1,
        itemIds: ['C1', 'C2', 'C3', 'C4'],
        sentences: [{ text: 'The agreement has payment, registration, penalty and termination terms.', cites: ['C1', 'C2'] }],
        dropped: 0,
      },
    ],
    crossClause: {
      findings: [{ kind: 'gap', text: 'No structured item covers insurance; the whole-document search found nothing.', itemIds: [], severity: 'medium' }],
      payments: [],
    },
    ledger: {
      chunks: [
        {
          chunkId: 'analysis:0',
          index: 0,
          pages: [1, 5],
          processed: true,
          detected: 4,
          analysed: 4,
          verified: 4,
          skipped: [],
          clauses: [],
          itemsAnalysed: 5,
          itemsVerified: 4,
        },
      ],
      totals: {
        chunks: 1,
        chunksProcessed: 1,
        clausesDetected: 4,
        clausesAnalysed: 4,
        clausesVerified: 4,
        clausesSkipped: 0,
        itemsAnalysed: 5,
        itemsVerified: 4,
        citedPages: [1, 2, 3, 4],
      },
    },
    metrics: {
      calls: 8,
      promptTokens: 1000,
      completionTokens: 500,
      costUsd: 0.01,
      p95DurationMs: 4000,
      retried: 0,
      split: 0,
      failed: 0,
      emptyOutput: 0,
      totalTasks: 2,
      doneTasks: 2,
      p95CompletionTokens: 100,
      recommendedMaxTokens: 200,
    },
    drops: [],
    amounts: {
      code: [
        {
          kind: 'money',
          text: 'Rs. 50,000',
          amount: 'Rs. 50,000',
          numeric: 50000,
          page: 1,
          clause: '1',
          quote: 'Rs. 50,000 brokerage is payable',
        },
      ],
      uncaptured: [],
    },
    resolution: { pageCorrected: 0, dropped: 0, skippedClauses: 0 },
    notices: [],
    judgement: {
      parties: { a: 'Alpha Holdings Limited', b: 'Beta Owners Association' },
      rows: [
        {
          clause: '4',
          page: 4,
          quote: 'Either party may terminate on 60 days notice',
          direction: 'favours_a',
          why: 'only the developer may terminate early',
        },
      ],
    },
  };
  return { ...report, ...overrides };
}

const GOLDEN: GoldenFile = {
  doc: 'Synthetic agreement.pdf',
  note: 'unit fixture',
  expected: [
    { clause: '1', token: '1,00,000', kind: 'payment' },
    { clause: '1', token: '50,000', kind: 'payment' },
    { clause: '1', token: '31 March 2027', kind: 'date' },
    { clause: '2', token: 'register', kind: 'obligation' },
    { clause: '2', token: '30 days', kind: 'obligation' },
    { clause: '3', token: 'interest', kind: 'risk' },
    { clause: '4', token: 'alpha', kind: 'favour' },
  ],
};

describe('quality scorer: recall', () => {
  it('reports model-only and model+code payment recall, and the other kinds', () => {
    const score = scoreDocument({ report: makeReport(), golden: GOLDEN, pages: PAGE_TEXT, tasks: TASKS });
    expect(score.recall.payment.expected).toBe(2);
    expect(score.recall.payment.modelFound).toBe(1);
    expect(score.recall.payment.combinedFound).toBe(2);
    expect(score.recall.payment.modelMisses.map((m) => m.token)).toEqual(['50,000']);
    expect(score.recall.date.modelFound).toBe(1);
    expect(score.recall.obligation.modelFound).toBe(2);
    expect(score.recall.risk.modelFound).toBe(1);
    expect(score.recall.favour.modelFound).toBe(1);
    expect(score.pass).toBe(true);
  });

  it('does not count an expectation from the wrong clause', () => {
    const golden: GoldenFile = { expected: [{ clause: '99', token: '1,00,000', kind: 'payment' }] };
    const score = scoreDocument({ report: makeReport(), golden, pages: PAGE_TEXT, tasks: TASKS });
    expect(score.recall.payment.modelFound).toBe(0);
  });

  it('matches a bare clause expectation against a sub-item', () => {
    const report = makeReport({
      clauses: [clause({ clauseNo: '23(a)', itemId: 'C23', payments: [CLAUSES[0].payments[0]] })],
    });
    const score = scoreDocument({
      report,
      golden: { expected: [{ clause: '23', token: '1,00,000', kind: 'payment' }] },
      pages: PAGE_TEXT,
      tasks: TASKS,
    });
    expect(score.recall.payment.modelFound).toBe(1);
  });
});

describe('quality scorer: precision', () => {
  it('counts only shown items in listed clauses that match a golden item', () => {
    const extra = { ...CLAUSES[0].payments[0], itemId: 'C1:p1', amount: 'Rs. 999', quote: 'The Purchaser shall pay Rs. 999' };
    const report = makeReport({ clauses: [{ ...CLAUSES[0], payments: [CLAUSES[0].payments[0], extra] }, ...CLAUSES.slice(1)] });
    const score = scoreDocument({ report, golden: GOLDEN, pages: PAGE_TEXT, tasks: TASKS });
    expect(score.precision.byKind.payment.shown).toBe(2);
    expect(score.precision.byKind.payment.onList).toBe(1);
    expect(score.precision.byKind.payment.precision).toBe(0.5);
  });
});

describe('quality scorer: quote validity', () => {
  it('re-checks every shown quote against its cited stored page', () => {
    const base = scoreDocument({ report: makeReport(), golden: GOLDEN, pages: PAGE_TEXT, tasks: TASKS });
    expect(base.quoteValidity.invalid).toEqual([]);
    expect(base.quoteValidity.rate).toBe(1);

    const wrongPage = makeReport({
      clauses: [{ ...CLAUSES[0], payments: [{ ...CLAUSES[0].payments[0], page: 2 }] }, ...CLAUSES.slice(1)],
    });
    const mismatch = checkQuoteValidity(wrongPage, PAGE_TEXT, wrongPage.judgement ?? null);
    expect(mismatch.invalid[0].reason).toBe('page_mismatch');
    expect(mismatch.invalid[0].foundPage).toBe(1);

    const missing = makeReport({
      clauses: [
        ...CLAUSES.slice(0, 3),
        {
          ...CLAUSES[3],
          risks: [
            {
              itemId: 'C4:r0',
              clause: '4',
              text: 'a penalty with no source',
              severity: 'high',
              page: 4,
              quote: 'This sentence is not anywhere in the document',
              verified: true,
              lawPassages: [],
              applicability: 'unverified',
            },
          ],
        },
      ],
    });
    const notFound = checkQuoteValidity(missing, PAGE_TEXT, null);
    expect(notFound.invalid.map((i) => i.reason)).toContain('not_found');
  });
});

describe('quality scorer: false missing claims', () => {
  it('flags a gap claim whose topic appears in the stored text', () => {
    const report = makeReport({
      crossClause: {
        findings: [
          {
            kind: 'gap',
            text: 'No structured item covers arbitration / dispute resolution; the whole-document search found nothing.',
            itemIds: [],
            severity: 'medium',
          },
        ],
        payments: [],
      },
    });
    const check = checkFalseMissing(report, PAGE_TEXT);
    expect(check.claims).toBe(1);
    expect(check.falseClaims).toHaveLength(1);
    expect(check.falseClaims[0].foundOnPage).toBe(4);
  });

  it('keeps a true missing claim when the topic is absent', () => {
    const check = checkFalseMissing(makeReport(), PAGE_TEXT);
    expect(check.claims).toBe(1);
    expect(check.falseClaims).toEqual([]);
  });
});

describe('quality scorer: overview fidelity', () => {
  it('requires every cite to exist and every figure to be supported by a cited item', () => {
    const report = makeReport({
      overview: [
        { text: 'The purchaser pays Rs. 1,00,000.', cites: ['C1'] },
        { text: 'The purchaser pays Rs. 9,99,999.', cites: ['C1'] },
        { text: 'A fact with no source.', cites: ['C99'] },
      ],
    });
    const check = checkOverview(report);
    expect(check.sentences).toBe(3);
    expect(check.okSentences).toBe(1);
    expect(check.issues[0].unsupportedFigures).toEqual(['999999']);
    expect(check.issues[1].unknownCites).toEqual(['C99']);
  });

  it('expands section-sentence IDs through their own cites', () => {
    const report = makeReport({
      overview: [{ text: 'The agreement has payment and registration terms.', cites: ['S1-1'] }],
    });
    expect(checkOverview(report).rate).toBe(1);
  });
});

describe('quality scorer: ledger vs saved tasks', () => {
  it('passes when ledger counts match the done chunk tasks', () => {
    const score = scoreDocument({ report: makeReport(), golden: GOLDEN, pages: PAGE_TEXT, tasks: TASKS });
    expect(score.ledger.ok).toBe(true);
  });

  it('fails when the ledger claims a processed chunk with no done task', () => {
    const report = makeReport({
      ledger: {
        ...makeReport().ledger,
        totals: { ...makeReport().ledger.totals, chunksProcessed: 2 },
      },
    });
    const score = scoreDocument({ report, golden: GOLDEN, pages: PAGE_TEXT, tasks: TASKS });
    expect(score.ledger.ok).toBe(false);
    expect(score.ledger.mismatches.join(' ')).toContain('processed chunks = done chunk tasks');
  });
});

describe('quality scorer: aggregate', () => {
  it('keeps hold-out scores out of the tuning aggregate', () => {
    const tuning = scoreDocument({ report: makeReport(), golden: GOLDEN, pages: PAGE_TEXT, tasks: TASKS });
    const holdout = scoreDocument({ report: makeReport({ runId: 'run-2' }), golden: { ...GOLDEN, holdout: true }, pages: PAGE_TEXT, tasks: TASKS });
    const agg = aggregateScores([tuning, holdout]);
    expect(agg.tuning.documents).toBe(1);
    expect(agg.holdout.documents).toBe(1);
    expect(tuning.holdout).toBe(false);
    expect(holdout.holdout).toBe(true);
  });
});

describe('repeat-run comparison', () => {
  it('reports overlap and items that appear in only one run', () => {
    const first = makeReport();
    const second = makeReport({
      clauses: [
        {
          ...CLAUSES[0],
          payments: [{ ...CLAUSES[0].payments[0], itemId: 'C1:p9', quote: 'The Purchaser shall pay Rs. 1,00,000 to the Developer' }],
        },
        ...CLAUSES.slice(1, 3),
      ],
    });
    const comparison = compareRuns(first, second);
    expect(comparison.counts.first).toBe(6);
    expect(comparison.counts.second).toBe(5);
    expect(comparison.counts.overlap).toBe(5); // payment + date in clause 1, the two clause-2 items and the clause-3 risk
    expect(comparison.onlyInFirst.map((i) => i.clause)).toEqual(['4']);
    expect(comparison.onlyInSecond).toEqual([]);
  });

  it('a quote in the wrong clause does not count as the same item', () => {
    const first = makeReport();
    const second = makeReport({
      clauses: [
        { ...CLAUSES[0], clauseNo: '4', payments: [{ ...CLAUSES[0].payments[0], clause: '4' }], dates: [] },
        ...CLAUSES.slice(1),
      ],
    });
    const comparison = compareRuns(first, second);
    expect(comparison.overlap.filter((i) => i.kind === 'payment')).toHaveLength(0);
    expect(comparison.onlyInSecond.filter((i) => i.kind === 'payment')).toHaveLength(1);
  });
});

describe('Hiramoti golden file', () => {
  it('parses the real golden file with the extended format', () => {
    const golden = hiramoti as GoldenFile;
    expect(goldenDocName(golden)).toBe('HIRAMOTI NAGAR CHSL DA DRAFT FOR MEMBERS 290626.pdf');
    expect(golden.holdout).not.toBe(true);
    expect(golden.expected.every((e) => ['payment', 'date', 'obligation', 'favour', 'risk'].includes(e.kind))).toBe(true);
  });

  it('scores a saved-run fixture against the real Hiramoti file (no model call)', () => {
    const pages = new Map<number, string>([
      [13, '13. Payment\nThe Purchaser shall pay Rs. 18,000 to the Developer.'],
      [10, '2. The Developer shall grant rights to the Purchaser.'],
    ]);
    const report = makeReport({
      docName: 'HIRAMOTI NAGAR CHSL DA DRAFT FOR MEMBERS 290626.pdf',
      clauses: [
        clause({
          clauseNo: '13',
          itemId: 'C13',
          payments: [
            {
              itemId: 'C13:p0',
              clause: '13',
              amount: 'Rs. 18,000',
              payer: 'Purchaser',
              payee: 'Developer',
              due: '',
              page: 13,
              quote: 'The Purchaser shall pay Rs. 18,000 to the Developer',
              verified: true,
            },
          ],
        }),
      ],
      overview: [],
      sections: [],
      crossClause: { findings: [], payments: [] },
      judgement: {
        parties: { a: 'Mandar', b: 'Members' },
        rows: [
          {
            clause: '2',
            page: 10,
            quote: 'The Developer shall grant rights to the Purchaser',
            direction: 'favours_a',
            why: 'rights',
          },
        ],
      },
    });
    const score = scoreDocument({ report, golden: hiramoti as GoldenFile, pages });
    expect(score.recall.payment.modelFound).toBe(1);
    expect(score.recall.favour.modelFound).toBe(1);
  });
});

describe('score history', () => {
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  it('stores one entry per run and reports the change against the previous run', () => {
    const storage = memoryStorage();
    const first = scoreDocument({ report: makeReport(), golden: GOLDEN, pages: PAGE_TEXT, tasks: TASKS });
    saveScore(storage, first, 1);
    const second = scoreDocument({
      report: makeReport({ runId: 'run-2' }),
      golden: GOLDEN,
      pages: PAGE_TEXT,
      tasks: TASKS.map((t) => ({ ...t, runId: 'run-2', id: t.id.replace('run-1', 'run-2') })),
    });
    const entries = saveScore(storage, second, 2);
    expect(entries).toHaveLength(2);

    const previous = previousScore(entries, second);
    expect(previous?.score.runId).toBe('run-1');
    const delta = compareScores(previous!.score, second);
    expect(delta.modelRecall).toBe(0);
    expect(delta.pass).toBe('same');

    saveScore(storage, second, 3);
    expect(loadHistory(storage)).toHaveLength(2);
  });

  it('reports a recall drop and a pass change', () => {
    const first = scoreDocument({ report: makeReport(), golden: GOLDEN, pages: PAGE_TEXT, tasks: TASKS });
    const worse = scoreDocument({
      report: makeReport({ runId: 'run-2', clauses: CLAUSES.slice(1) }),
      golden: GOLDEN,
      pages: PAGE_TEXT,
      tasks: TASKS,
    });
    const delta = compareScores(first, worse);
    expect(delta.modelRecall).toBeLessThan(0);
    expect(delta.pass).toBe('worsened');
  });
});
