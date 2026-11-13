import { describe, it, expect } from 'vitest';
import { buildReportModel, compareClauseNo, longestOf, mergeClauses, placeEntry, unreviewedText, NOT_STATED } from './reportModel';
import type { AnalysisReport, VerifiedClause, VerifiedRisk } from './types';

const risk = (id: string, severity: 'high' | 'medium' | 'low', page: number, quote: string, clause: string): VerifiedRisk => ({
  itemId: id, clause, text: `risk ${id}`, severity, basis: 'other', suggestion: `fix ${id}`, laws: ['Act X'],
  page, quote, verified: true, applicability: 'unverified',
});

const clause = (over: Partial<VerifiedClause> & { itemId: string; clauseNo: string }): VerifiedClause => ({
  type: 'obligation', summary: '', chunkId: 'analysis:0', chunkIndex: 0, pageStart: 1, pageEnd: 1,
  obligations: [], dates: [], payments: [], risks: [], verifiedItems: 0, ...over,
});

const report = (clauses: VerifiedClause[], extra: Partial<AnalysisReport> = {}): AnalysisReport =>
  ({
    docId: 'd', docHash: 'h', docName: 'sample.pdf', runId: 'r', createdAt: Date.UTC(2026, 10, 12), model: 'm', lawVersion: 'v',
    definitions: { parties: [], defined_terms: [], key_dates: [] },
    clauses, overview: [], sections: [], crossClause: { findings: [], payments: [] },
    ledger: { totals: { clausesDetected: clauses.length, clausesAnalysed: clauses.length, clausesSkipped: 0 } } as never,
    metrics: {} as never, drops: [], amounts: { code: [], uncaptured: [] }, resolution: { pageCorrected: 0, dropped: 0, skippedClauses: 0 },
    notices: [], ...extra,
  }) as unknown as AnalysisReport;

describe('clause placement', () => {
  it('places an unnumbered entry from the clause on its own verified quotes', () => {
    const entry = clause({ itemId: 'x', clauseNo: 'risks', risks: [risk('r1', 'low', 3, 'quote here', '4')] });
    expect(placeEntry(entry, new Map())).toEqual({ key: '4', how: 'quotes' });
  });

  it('places from the chunk clause list only when it names exactly one clause', () => {
    const entry = clause({ itemId: 'x', clauseNo: 'obligations', chunkIndex: 2 });
    expect(placeEntry(entry, new Map([[2, ['7']]]))).toEqual({ key: '7', how: 'chunk' });
    expect(placeEntry(entry, new Map([[2, ['7', '8']]]))).toEqual({ key: null, how: null });
  });

  it('keeps an entry that cannot be placed as its own row, never dropped', () => {
    const r = report([
      clause({ itemId: 'a', clauseNo: '1', pageStart: 1, summary: 'one' }),
      clause({ itemId: 'b', clauseNo: 'risks', chunkIndex: 5, pageStart: 2 }),
      clause({ itemId: 'c', clauseNo: '#1', chunkIndex: 5, pageStart: 2 }),
    ], { chunkClauses: [{ chunkIndex: 5, clauses: ['2', '3'] }] });
    const { rows, stats } = mergeClauses(r);
    expect(rows).toHaveLength(3);
    expect(rows.filter((x) => x.unplaced)).toHaveLength(2);
    expect(stats).toMatchObject({ entries: 3, unmerged: 2, merged: 0, rows: 3 });
  });
});

describe('merging', () => {
  it('merges entries that share a clause number, with longest prose and unioned lists', () => {
    const merged = clause({
      itemId: 'm1', clauseNo: '3', pageStart: 4, pageEnd: 4, summary: 'Short.',
      prose: { detailed_summary: 'A short detail.', conditions: '', exceptions: '', rights: '', legal_significance: '', ambiguity: '', suggested_action: '', location_mismatch: '' },
      missing: ['No notice period'],
      risks: [risk('r1', 'medium', 4, 'first risk quote', '3')],
    });
    const second = clause({
      itemId: 'm2', clauseNo: '3', pageStart: 5, pageEnd: 5, summary: 'A longer, complete summary of clause three.',
      prose: { detailed_summary: 'A short detail.', conditions: 'Only on signing.', exceptions: '', rights: '', legal_significance: '', ambiguity: '', suggested_action: '', location_mismatch: '' },
      missing: ['no notice period', 'No governing law'],
      risks: [risk('r2', 'high', 5, 'second risk quote', '3')],
    });
    const { rows, stats } = mergeClauses(report([merged, second]));
    expect(rows).toHaveLength(1);
    const c = rows[0].clause;
    expect(rows[0].sources).toBe(2);
    expect(c.summary).toBe('A longer, complete summary of clause three.');
    expect(c.prose?.conditions).toBe('Only on signing.');
    expect(c.pageStart).toBe(4);
    expect(c.pageEnd).toBe(5);
    expect(c.missing).toEqual(['No notice period', 'No governing law']);
    expect(c.risks.map((x) => x.severity)).toEqual(['high', 'medium']);
    expect(stats).toMatchObject({ merged: 1, unmerged: 0 });
  });

  it('longestOf takes the longest non-empty value and never joins', () => {
    expect(longestOf(['', ' short ', 'much longer text'])).toBe('much longer text');
    expect(longestOf([undefined, null, ''])).toBe('');
  });

  it('keeps sub-clauses separate from their parent', () => {
    const { rows } = mergeClauses(report([clause({ itemId: 'a', clauseNo: '1' }), clause({ itemId: 'b', clauseNo: '1.1' })]));
    expect(rows).toHaveLength(2);
  });
});

describe('report model', () => {
  it('numbers sections in order and drops Prompt Result when unused', () => {
    const model = buildReportModel(report([clause({ itemId: 'a', clauseNo: '1' })]));
    expect(model.sections.map((s) => s.title)).toEqual([
      'Overview', 'Clause Breakdown', 'Dates and Amounts', 'Obligations by Party',
      'Risk Register', 'Internal Inconsistencies', 'Coverage',
    ]);
    expect(model.sections.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(model.sections.some((s) => /Defined Terms/.test(s.title))).toBe(false);
  });

  it('adds Prompt Result as section 2 and renumbers the rest when used', () => {
    const model = buildReportModel(
      report([clause({ itemId: 'a', clauseNo: '1' })], {
        promptResult: { prompt: 'p', answers: [], chunksTotal: 1, chunksDone: 1, failedChunks: [] },
      }),
    );
    expect(model.toc.slice(0, 3).map((t) => t.title)).toEqual(['Overview', 'Prompt Result', 'Clause Breakdown']);
    expect(model.toc.map((t) => t.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps the clause table to the rows that have content, with Summary always present', () => {
    const model = buildReportModel(report([clause({ itemId: 'a', clauseNo: '1', summary: 'Sum.' })]));
    const labels = model.clauses[0].rows.map((r) => r.label);
    expect(labels).toEqual(['Summary']);
    expect(labels).not.toContain('Missing');
    expect(labels).not.toContain('Exceptions & carve-outs');
    expect(labels).not.toContain('Risk note');
    expect(NOT_STATED).toMatch(/Not stated/);
  });

  it('shows Law references and Quoted text only when they have content', () => {
    const model = buildReportModel(report([clause({ itemId: 'a', clauseNo: '1', summary: 'Sum.', risks: [risk('r1', 'low', 1, 'a quote here', '1')] })]));
    const labels = model.clauses[0].rows.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(['Summary', 'Law references', 'Quoted text', 'Suggested action']));
  });

  it('sorts clauses by clause number, numerically, with unplaced entries last', () => {
    const model = buildReportModel(
      report([
        clause({ itemId: 'a', clauseNo: '10', pageStart: 1 }),
        clause({ itemId: 'b', clauseNo: '2', pageStart: 5 }),
        clause({ itemId: 'c', clauseNo: '3.10', pageStart: 2 }),
        clause({ itemId: 'd', clauseNo: '3.2', pageStart: 3 }),
        clause({ itemId: 'e', clauseNo: 'risks', chunkIndex: 9, pageStart: 0 }),
      ]),
    );
    expect(model.clauses.map((c) => c.clauseNo)).toEqual(['2', '3.2', '3.10', '10', 'risks']);
  });

  it('cleans underscores from type labels', () => {
    const model = buildReportModel(report([clause({ itemId: 'a', clauseNo: '1', type: 'payment_terms' })]));
    expect(model.clauses[0].type).toBe('payment terms');
  });

  it('compares clause numbers naturally', () => {
    expect(compareClauseNo('2', '10')).toBeLessThan(0);
    expect(compareClauseNo('3.2', '3.10')).toBeLessThan(0);
    expect(compareClauseNo('4', '4')).toBe(0);
  });

  it('never prints a zero clause count, and in structure-free runs shows chunk coverage only', () => {
    const zero = buildReportModel(report([], { coverage: { mode: 'structure' } as never }));
    expect(zero.sections.find((s) => s.key === 'coverage')).toMatchObject({ lines: expect.not.arrayContaining([expect.stringMatching(/Clauses detected 0/)]) });
    const free = buildReportModel(
      report([clause({ itemId: 'a', clauseNo: '1' })], {
        coverage: { mode: 'structure-free', totalChunks: 3, analysedChunks: 3, totalPages: 2, pagesCovered: 2 } as never,
      }),
    );
    const lines = (free.sections.find((s) => s.key === 'coverage') as { lines: string[] }).lines;
    expect(lines.some((l) => /Clauses detected/.test(l))).toBe(false);
    expect(lines[0]).toMatch(/Chunks analysed 3 of 3/);
  });

  it('shows the synthesized answer in prose and supporting quotes grouped by clause', () => {
    const a = { itemId: 'P1', text: 'Yes, sixty days.', clause: '3', page: 2, quote: 'sixty days written notice', verified: true as const, part: 'answer' as const };
    const model = buildReportModel(
      report([clause({ itemId: 'a', clauseNo: '1' })], {
        promptResult: {
          prompt: 'Is there a notice period?',
          answers: [a, { ...a, itemId: 'P2', part: 'support' }],
          answer: [{ text: 'Yes, either party may end it on sixty days.', cites: ['P1'] }],
          chunksTotal: 1,
          chunksDone: 1,
          failedChunks: [],
        },
      }),
    );
    const pr = model.sections.find((s) => s.key === 'promptResult') as Extract<(typeof model.sections)[number], { key: 'promptResult' }>;
    expect(pr.answer).toHaveLength(1);
    expect(pr.answer[0].citations[0]).toMatchObject({ clause: '3', page: 2 });
    expect(pr.groups).toEqual([{ clause: '3', quotes: [{ quote: 'sixty days written notice', citation: expect.objectContaining({ page: 2 }) }] }]);
  });

  it('splits dates and amounts into two tables and falls back to the quote when there is no purpose', () => {
    const model = buildReportModel(
      report([
        clause({
          itemId: 'a',
          clauseNo: '1',
          dates: [
            { itemId: 'd1', clause: '1', text: '12 May 2024', purpose: 'Completion date', timing_type: 'fixed', page: 1, quote: 'completion on 12 May 2024', verified: true },
            { itemId: 'd2', clause: '1', text: 'the Closing Date', timing_type: 'event_relative', page: 1, quote: 'no purpose stated for this date', verified: true },
          ],
          payments: [
            { itemId: 'p1', clause: '1', amount: 'Rs. 48,000', purpose: 'Price', payer: 'Buyer', payee: 'Supplier', due: 'on delivery', page: 1, quote: 'price of Rs. 48,000', verified: true },
          ],
        }),
      ]),
    );
    const da = model.sections.find((s) => s.key === 'datesAmounts') as Extract<(typeof model.sections)[number], { key: 'datesAmounts' }>;
    expect(da.dates.map((d) => [d.date, d.purpose, d.timing])).toEqual([
      ['12 May 2024', 'Completion date', 'fixed'],
      ['the Closing Date', 'no purpose stated for this date', 'relative'],
    ]);
    expect(da.amounts[0]).toMatchObject({ amount: 'Rs. 48,000', purpose: 'Price', payerToPayee: 'Buyer to Supplier', due: 'on delivery' });
  });

  it('shows whether the missing pass ran, with raw and rejected counts', () => {
    const run = buildReportModel(
      report([clause({ itemId: 'a', clauseNo: '1' })], {
        missingStats: { proposed: 0, kept: 0, droppedCovered: 0, possiblyMissing: 0, passRan: true, rawItems: 3, rejectedBySchema: 3, tasksDone: 1, tasksFailed: 0 },
      }),
    );
    const sec = run.sections.find((s) => s.key === 'risks') as Extract<(typeof run.sections)[number], { key: 'risks' }>;
    expect(sec.missingLine).toMatch(/pass ran: yes/);
    expect(sec.missingLine).toMatch(/raw items: 3/);
    expect(sec.missingLine).toMatch(/rejected by schema: 3/);

    const skipped = buildReportModel(report([], { missingStats: { proposed: 0, kept: 0, droppedCovered: 0, possiblyMissing: 0, passRan: false } }));
    const s2 = skipped.sections.find((s) => s.key === 'risks') as Extract<(typeof skipped.sections)[number], { key: 'risks' }>;
    expect(s2.missingLine).toMatch(/pass ran: no/);
  });

  it('shows the risk validation count when a review ran', () => {
    const model = buildReportModel(report([clause({ itemId: 'a', clauseNo: '1' })], { riskReview: { reviewed: 12, kept: 9, downgraded: 1, dropped: 2 } }));
    const risks = model.sections.find((s) => s.key === 'risks') as Extract<(typeof model.sections)[number], { key: 'risks' }>;
    expect(risks.reviewLine).toBe('12 risks after validation (2 dropped).');
  });

  it('sorts risks by priority and labels law references, with missing protections as their own list', () => {
    const model = buildReportModel(
      report(
        [clause({ itemId: 'a', clauseNo: '1', risks: [risk('r1', 'low', 1, 'q one', '1'), risk('r2', 'high', 1, 'q two', '1')] })],
        {
          missingProtections: [
            { itemId: 'M1', topic: 'insurance', text: 'No cover stated.', severity: 'medium', basis: 'other', suggestion: 'Ask.', laws: ['Act Y'], cites: [], applicability: 'unverified' },
          ],
        },
      ),
    );
    const risks = model.sections.find((s) => s.key === 'risks') as Extract<(typeof model.sections)[number], { key: 'risks' }>;
    expect(risks.risks.map((r) => r.priority)).toEqual(['high', 'low']);
    expect(risks.risks.every((r) => r.suggestion.length > 0 && r.laws.length > 0)).toBe(true);
    expect(risks.missing[0]).toMatchObject({ clause: 'Whole document', kind: 'missing' });
  });

  it('shows whether the missing pass ran, with raw and rejected counts', () => {
    const run = buildReportModel(
      report([clause({ itemId: 'a', clauseNo: '1' })], {
        missingStats: { proposed: 0, kept: 0, droppedCovered: 0, possiblyMissing: 0, passRan: true, rawItems: 3, rejectedBySchema: 3, tasksDone: 1, tasksFailed: 0 },
      }),
    );
    const sec = run.sections.find((s) => s.key === 'risks') as Extract<(typeof run.sections)[number], { key: 'risks' }>;
    expect(sec.missingLine).toMatch(/pass ran: yes/);
    expect(sec.missingLine).toMatch(/raw items: 3/);
    expect(sec.missingLine).toMatch(/rejected by schema: 3/);

    const skipped = buildReportModel(report([], { missingStats: { proposed: 0, kept: 0, droppedCovered: 0, possiblyMissing: 0, passRan: false } }));
    const s2 = skipped.sections.find((s) => s.key === 'risks') as Extract<(typeof skipped.sections)[number], { key: 'risks' }>;
    expect(s2.missingLine).toMatch(/pass ran: no/);
  });

  it('shows the risk validation count when a review ran', () => {
    const model = buildReportModel(report([clause({ itemId: 'a', clauseNo: '1' })], { riskReview: { reviewed: 12, kept: 9, downgraded: 1, dropped: 2 } }));
    const risks = model.sections.find((s) => s.key === 'risks') as Extract<(typeof model.sections)[number], { key: 'risks' }>;
    expect(risks.reviewLine).toBe('12 risks after validation (2 dropped).');
  });

  it('sorts risks by priority and labels law references, with missing protections as their own list', () => {
    const model = buildReportModel(
      report(
        [clause({ itemId: 'a', clauseNo: '1', risks: [risk('r1', 'low', 1, 'q one', '1'), risk('r2', 'high', 1, 'q two', '1')] })],
        {
          missingProtections: [
            { itemId: 'M1', topic: 'insurance', text: 'No cover stated.', severity: 'medium', basis: 'other', suggestion: 'Ask.', laws: ['Act Y'], cites: [], applicability: 'unverified' },
          ],
        },
      ),
    );
    const risks = model.sections.find((s) => s.key === 'risks') as Extract<(typeof model.sections)[number], { key: 'risks' }>;
    expect(risks.risks.map((r) => r.priority)).toEqual(['high', 'low']);
    expect(risks.risks.every((r) => r.suggestion.length > 0 && r.laws.length > 0)).toBe(true);
    expect(risks.missing[0]).toMatchObject({ clause: 'Whole document', kind: 'missing' });
  });

});

describe('unreviewed pages banner', () => {
  it('states how many pages were not reviewed and stays absent otherwise', () => {
    expect(unreviewedText(0)).toBeNull();
    expect(unreviewedText(1)).toBe('1 page was not reviewed; OCR text was used as extracted.');
    expect(unreviewedText(4)).toBe('4 pages were not reviewed; OCR text was used as extracted.');
    expect(buildReportModel(report([], { unreviewedPages: 2 })).unreviewed).toBe(
      '2 pages were not reviewed; OCR text was used as extracted.',
    );
    expect(buildReportModel(report([])).unreviewed).toBeNull();
  });
});
