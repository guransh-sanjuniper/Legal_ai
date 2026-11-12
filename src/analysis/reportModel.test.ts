import { describe, it, expect } from 'vitest';
import { buildReportModel, longestOf, mergeClauses, placeEntry, NOT_STATED } from './reportModel';
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
      'Overview', 'Clause Breakdown', 'Dates and Amounts', 'Obligations by Party', 'Timeline',
      'Risk Register', 'Internal Inconsistencies', 'Coverage',
    ]);
    expect(model.sections.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(model.sections.some((s) => /Defined Terms/.test(s.title))).toBe(false);
  });

  it('adds Prompt Result as section 2 and renumbers the rest when used', () => {
    const model = buildReportModel(
      report([clause({ itemId: 'a', clauseNo: '1' })], {
        promptResult: { prompt: 'p', answers: [], chunksTotal: 1, chunksDone: 1, failedChunks: [] },
      }),
    );
    expect(model.toc.slice(0, 3).map((t) => t.title)).toEqual(['Overview', 'Prompt Result', 'Clause Breakdown']);
    expect(model.toc.map((t) => t.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('shows Missing as None when complete and not checked for older reports', () => {
    const model = buildReportModel(report([clause({ itemId: 'a', clauseNo: '1', missing: [] }), clause({ itemId: 'b', clauseNo: '2' })]));
    expect(model.clauses.find((c) => c.clauseNo === '1')?.missing).toEqual([]);
    expect(model.clauses.find((c) => c.clauseNo === '2')?.missing).toBeNull();
  });

  it('leaves out conditional rows that are empty, and keeps the others with their label', () => {
    const model = buildReportModel(report([clause({ itemId: 'a', clauseNo: '1', summary: 'Sum.' })]));
    const labels = model.clauses[0].rows.map((r) => r.label);
    expect(labels).toContain('Summary');
    expect(labels).toContain('Quoted text');
    expect(labels).not.toContain('Dates');
    expect(labels).not.toContain('Amounts');
    expect(labels).not.toContain('Location mismatch');
    expect(NOT_STATED).toMatch(/Not stated/);
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

  it('builds the timeline in date order, unparsed dates after', () => {
    const d = (text: string, page: number) => ({ text, timing_type: 'fixed' as const, page, quote: `quote ${text}`, verified: true as const, itemId: `d${text}`, clause: '1' });
    const model = buildReportModel(report([clause({ itemId: 'a', clauseNo: '1', dates: [d('3 March 2024', 2), d('later', 3), d('12 May 2024', 1)] })]));
    const tl = model.sections.find((s) => s.key === 'timeline') as Extract<(typeof model.sections)[number], { key: 'timeline' }>;
    expect(tl.rows.map((r) => r.date)).toEqual(['3 March 2024', '12 May 2024', 'later']);
  });
});
