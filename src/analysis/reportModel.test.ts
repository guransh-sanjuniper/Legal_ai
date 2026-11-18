import { describe, it, expect } from 'vitest';
import { buildReportModel, compareClauseNo, longestOf, mergeClauses, placeEntry, PROMPT_TRUNCATED_NOTE, unreviewedText, NOT_STATED } from './reportModel';
import { buildBlocksBlocking } from '../export/blocks';
import type { AnalysisReport, PromptAnswer, VerifiedClause, VerifiedRisk } from './types';

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

  it('keeps the export blocks for a stored Prompt Result report byte-identical', () => {
    // Baseline captured before the on-screen Prompt Result work: the exports must not change.
    // The report is in the stored (old-style) shape: a flat answer and capped supporting quotes.
    const promptAnswers: PromptAnswer[] = Array.from({ length: 6 }, (_, i) => ({
      itemId: `P${i + 1}`,
      text: `answer ${i + 1}`,
      clause: '4',
      page: i + 2,
      quote: `verified quote ${i + 1}`,
      verified: true as const,
      part: (i === 0 ? 'answer' : 'support') as PromptAnswer['part'],
    }));
    const exported = buildReportModel(
      report([clause({ itemId: 'a', clauseNo: '1' })], {
        promptResult: {
          prompt: 'What is the security deposit?',
          answers: promptAnswers,
          answer: [{ text: 'The deposit is refundable on exit.', cites: ['P1'] }],
          mode: 'inline',
          chunksTotal: 2,
          chunksDone: 2,
          failedChunks: [],
        },
      }),
    );
    expect(buildBlocksBlocking(exported).filter((b) => b.kind !== 'table' || b.columns[0] !== 'Field')).toMatchInlineSnapshot(`
      [
        {
          "kind": "title",
          "text": "Deep Analysis Report",
        },
        {
          "kind": "meta",
          "rows": [
            {
              "label": "Matter",
              "value": "—",
            },
            {
              "label": "Document",
              "value": "sample.pdf",
            },
            {
              "label": "Review date",
              "value": "12/11/2026",
            },
            {
              "label": "Detail level",
              "value": "standard",
            },
            {
              "label": "Focus",
              "value": "—",
            },
            {
              "label": "Reviewing for",
              "value": "Neutral",
            },
          ],
        },
        {
          "kind": "heading",
          "level": 2,
          "text": "Table of Contents",
        },
        {
          "entries": [
            {
              "number": 1,
              "title": "Overview",
            },
            {
              "number": 2,
              "title": "Prompt Result",
            },
            {
              "number": 3,
              "title": "Clause Breakdown",
            },
            {
              "number": 4,
              "title": "Dates and Amounts",
            },
            {
              "number": 5,
              "title": "Obligations by Party",
            },
            {
              "number": 6,
              "title": "Risk Register",
            },
            {
              "number": 7,
              "title": "Internal Inconsistencies",
            },
            {
              "number": 8,
              "title": "Coverage",
            },
          ],
          "kind": "toc",
        },
        {
          "kind": "heading",
          "level": 2,
          "text": "1. Overview",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "1. Nature and Purpose",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "2. Parties and Their Roles",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "3. Subject Matter / Property and Key Particulars",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "4. Commercial Terms",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "5. Timeline and Milestones",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "6. Obligations by Party",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "7. Rights and Protections by Party",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "8. Termination and Exit",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "9. Dispute Resolution, Governing Law, Jurisdiction",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "10. Statutory Compliance",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "11. Notable Drafting Issues",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "12. Internal Inconsistencies",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "13. Executive Summary",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Not stated in the document",
        },
        {
          "kind": "heading",
          "level": 2,
          "text": "2. Prompt Result",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Prompt: “What is the security deposit?”",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Answered with the clause analysis, with no extra reading pass.",
        },
        {
          "kind": "paragraph",
          "text": "The deposit is refundable on exit.",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "Supporting quotes",
        },
        {
          "items": [
            "“verified quote 1” (Clause 4 · p. 2)",
            "“verified quote 2” (Clause 4 · p. 3)",
            "“verified quote 3” (Clause 4 · p. 4)",
            "“verified quote 4” (Clause 4 · p. 5)",
          ],
          "kind": "bullets",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "+2 more sources",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "Chunks answered 2 of 2.",
        },
        {
          "kind": "heading",
          "level": 2,
          "text": "3. Clause Breakdown",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "1 stored entries → 1 clause rows. 0 unnumbered entries placed by their quotes or chunk; 0 merged into another row; 0 kept separate because they could not be placed.",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "Clause 1 · obligation",
        },
        {
          "kind": "heading",
          "level": 2,
          "text": "4. Dates and Amounts",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "Dates",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "No dates with a stated purpose were found.",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "Amounts",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "No amounts were found.",
        },
        {
          "kind": "heading",
          "level": 2,
          "text": "5. Obligations by Party",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "No obligations were found in the verified items.",
        },
        {
          "kind": "heading",
          "level": 2,
          "text": "6. Risk Register",
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "Risks",
        },
        {
          "columns": [
            "#",
            "Level",
            "Clause and page",
            "Affects",
            "Issue",
            "Law references",
            "Suggested next steps",
          ],
          "kind": "table",
          "rows": [],
        },
        {
          "kind": "heading",
          "level": 3,
          "text": "Missing clauses and protections",
        },
        {
          "columns": [
            "#",
            "Level",
            "Clause and page",
            "Affects",
            "Issue",
            "Law references",
            "Suggested next steps",
          ],
          "kind": "table",
          "rows": [],
        },
        {
          "kind": "heading",
          "level": 2,
          "text": "7. Internal Inconsistencies",
        },
        {
          "kind": "paragraph",
          "muted": true,
          "text": "No inconsistency was found by the checks.",
        },
        {
          "kind": "heading",
          "level": 2,
          "text": "8. Coverage",
        },
        {
          "items": [
            "Clauses detected 1; analysed 1; not analysed 0.",
            "Failed clause units: 0.",
          ],
          "kind": "bullets",
        },
        {
          "kind": "footer",
          "text": "AI-assisted, requires lawyer review",
        },
      ]
    `);
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

  it('caps the supporting quotes and counts the ones not shown', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      itemId: `P${i + 1}`,
      text: `text ${i + 1}`,
      clause: '3',
      page: i + 2,
      quote: `quote ${i + 1}`,
      verified: true as const,
      part: 'support' as const,
    }));
    const model = buildReportModel(
      report([], {
        promptResult: {
          prompt: 'What is this document about?',
          answers: many,
          // The prose leads with the last answer, so that quote is shown first.
          answer: [{ text: 'It is a lease.', cites: ['P6'] }],
          chunksTotal: 1,
          chunksDone: 1,
          failedChunks: [],
        },
      }),
    );
    const pr = model.sections.find((s) => s.key === 'promptResult') as Extract<(typeof model.sections)[number], { key: 'promptResult' }>;
    const shown = pr.groups.flatMap((g) => g.quotes);
    expect(shown).toHaveLength(4);
    expect(shown[0].quote).toBe('quote 6');
    expect(pr.sourcesMore).toBe(2);
  });

  it('shows every supporting quote when there are fewer than the cap', () => {
    const model = buildReportModel(
      report([], {
        promptResult: {
          prompt: 'What is the deposit?',
          answers: [
            { itemId: 'P1', text: 'a', clause: '4', page: 2, quote: 'deposit one', verified: true, part: 'answer' },
            { itemId: 'P2', text: 'b', clause: '4', page: 3, quote: 'deposit two', verified: true, part: 'support' },
          ],
          answer: [{ text: 'It is Rs 50,000.', cites: ['P1'] }],
          chunksTotal: 1,
          chunksDone: 1,
          failedChunks: [],
        },
      }),
    );
    const pr = model.sections.find((s) => s.key === 'promptResult') as Extract<(typeof model.sections)[number], { key: 'promptResult' }>;
    expect(pr.groups.flatMap((g) => g.quotes)).toHaveLength(2);
    expect(pr.sourcesMore).toBe(0);
  });

  it('shows the synthesis failure message instead of claiming nothing was found', () => {
    const model = buildReportModel(
      report([], {
        promptResult: {
          prompt: 'Who may terminate?',
          answers: [{ itemId: 'P1', text: 'q', clause: '7', page: 1, quote: 'notice', verified: true }],
          answer: [],
          error: 'Answer generation failed (bad_json). The verified quotes are listed below.',
          chunksTotal: 2,
          chunksDone: 2,
          failedChunks: [],
        },
      }),
    );
    const pr = model.sections.find((s) => s.key === 'promptResult') as Extract<(typeof model.sections)[number], { key: 'promptResult' }>;
    expect(pr.error).toMatch(/Answer generation failed \(bad_json\)/);
    expect(pr.answer).toEqual([]);
  });

  it('numbers sources in first-appearance order and points every marker at its row', () => {
    const a = (itemId: string, page: number, quote: string) => ({
      itemId, text: quote, clause: '4', page, quote, verified: true as const, part: 'support' as const,
    });
    const model = buildReportModel(
      report([], {
        promptResult: {
          prompt: 'What is the security deposit?',
          answers: [a('P1', 6, 'the deposit is refundable'), a('P2', 3, 'the deposit is fifty thousand'), a('P3', 8, 'an unrelated quote')],
          // The prose leads with the later quote, so it is numbered first.
          answer: [
            { text: 'It is fifty thousand.', cites: ['P2'] },
            { text: 'It is refundable.', cites: ['P1', 'P2'] },
          ],
          chunksTotal: 1,
          chunksDone: 1,
          failedChunks: [],
        },
      }),
    );
    const pr = model.sections.find((s) => s.key === 'promptResult') as Extract<(typeof model.sections)[number], { key: 'promptResult' }>;
    expect(pr.parts).toHaveLength(1);
    expect(pr.parts![0].heading).toBeNull();
    expect(pr.sources!.map((s) => [s.n, s.page, s.quote])).toEqual([
      [1, 3, 'the deposit is fifty thousand'],
      [2, 6, 'the deposit is refundable'],
    ]);
    const sentences = pr.parts![0].sentences;
    expect(sentences.map((s) => s.markers)).toEqual([[1], [2, 1]]);
    // Every marker resolves to a source row with the same clause, page and quote.
    for (const s of sentences) {
      for (const n of s.markers) {
        const row = pr.sources!.find((row) => row.n === n)!;
        expect(row).toBeDefined();
      }
      expect(s.citations).toHaveLength(s.markers.length);
    }
    expect(pr.stats).toMatchObject({ cited: 2, pageStart: 3, pageEnd: 6 });
  });

  it('never caps the sources and keeps their numbering stable', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      itemId: `P${i + 1}`, text: `text ${i + 1}`, clause: '3', page: i + 2,
      quote: `quote ${i + 1}`, verified: true as const, part: 'support' as const,
    }));
    const model = buildReportModel(
      report([], {
        promptResult: {
          prompt: 'List the deposit terms.',
          answers: many,
          answer: many.map((a, i) => ({ text: `Point ${i + 1}.`, cites: [a.itemId] })),
          chunksTotal: 1,
          chunksDone: 1,
          failedChunks: [],
        },
      }),
    );
    const pr = model.sections.find((s) => s.key === 'promptResult') as Extract<(typeof model.sections)[number], { key: 'promptResult' }>;
    expect(pr.sources!.map((s) => s.n)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(pr.sources!.map((s) => s.page)).toEqual(Array.from({ length: 12 }, (_, i) => i + 2));
    expect(pr.stats).toMatchObject({ cited: 12, pageStart: 2, pageEnd: 13 });
    // The export cap is unchanged.
    expect(pr.sourcesMore).toBe(8);
    expect(pr.groups.flatMap((g) => g.quotes)).toHaveLength(4);
  });

  it('groups a multi-part answer under the user wording, keeping bullet styles', () => {
    const answers = [
      { itemId: 'PA1', text: 'q1', clause: '2', page: 2, quote: 'the deposit is fifty thousand', verified: true as const },
      { itemId: 'PA2', text: 'q2', clause: '5', page: 5, quote: 'the deposit is refunded in sixty days', verified: true as const },
    ];
    const model = buildReportModel(
      report([], {
        promptResult: {
          prompt: 'What is the deposit and when is it refunded?',
          answers,
          answer: [{ text: 'The deposit is fifty thousand.', cites: ['PA1'] }],
          parts: [
            { heading: 'What is the deposit', sentences: [{ text: 'The deposit is fifty thousand.', cites: ['PA1'] }], notStated: false, truncated: false, error: null },
            {
              heading: 'when is it refunded',
              sentences: [{ text: 'It is refunded in sixty days.', cites: ['PA2'], style: 'bullet' }],
              notStated: false,
              truncated: false,
              error: null,
            },
          ],
          chunksTotal: 1,
          chunksDone: 1,
          failedChunks: [],
        },
      }),
    );
    const pr = model.sections.find((s) => s.key === 'promptResult') as Extract<(typeof model.sections)[number], { key: 'promptResult' }>;
    expect(pr.parts!.map((p) => p.heading)).toEqual(['What is the deposit', 'when is it refunded']);
    expect(pr.parts![1].sentences[0].style).toBe('bullet');
    expect(pr.parts![1].sentences[0].markers).toEqual([2]);
  });

  it('shows an unsupported part as "Not clearly stated" without a marker', () => {
    const model = buildReportModel(
      report([], {
        promptResult: {
          prompt: 'What is the deposit and who witnesses it?',
          answers: [{ itemId: 'PA1', text: 'q1', clause: '2', page: 2, quote: 'the deposit is fifty thousand', verified: true }],
          answer: [{ text: 'The deposit is fifty thousand.', cites: ['PA1'] }],
          parts: [
            { heading: 'What is the deposit', sentences: [{ text: 'The deposit is fifty thousand.', cites: ['PA1'] }], notStated: false, truncated: false, error: null },
            { heading: 'who witnesses it', sentences: [], notStated: true, truncated: false, error: null },
          ],
          chunksTotal: 1,
          chunksDone: 1,
          failedChunks: [],
        },
      }),
    );
    const pr = model.sections.find((s) => s.key === 'promptResult') as Extract<(typeof model.sections)[number], { key: 'promptResult' }>;
    expect(pr.parts![1]).toMatchObject({ heading: 'who witnesses it', notStated: true, sentences: [] });
    expect(pr.truncatedNote).toBeNull();
  });

  it('shows a broad request\'s plain reason instead of the generic line', () => {
    const reason = 'I could not find passages that clearly answer this request.';
    const model = buildReportModel(
      report([], {
        promptResult: {
          prompt: 'Generate a comprehensive report of the uploaded document.',
          answers: [{ itemId: 'PA1', text: 'q', clause: '4', page: 6, quote: 'a verified quote', verified: true }],
          answer: [{ text: reason, cites: [] }],
          parts: [
            {
              heading: null,
              sentences: [{ text: reason, cites: [] }],
              notStated: true,
              notStatedText: reason,
              truncated: false,
              error: null,
            },
          ],
          stats: { excluded: 0, moreFindings: 3 },
          chunksTotal: 1,
          chunksDone: 1,
          failedChunks: [],
        },
      }),
    );
    const pr = model.sections.find((s) => s.key === 'promptResult') as Extract<(typeof model.sections)[number], { key: 'promptResult' }>;
    expect(pr.parts![0]).toMatchObject({ notStated: true, sentences: [], notStatedText: reason });
    expect(pr.stats).toMatchObject({ moreFindings: 3 });
  });

  it('shows the truncation notice when a part was cut off', () => {
    const model = buildReportModel(
      report([], {
        promptResult: {
          prompt: 'Summarise every obligation.',
          answers: [{ itemId: 'PA1', text: 'q1', clause: '2', page: 2, quote: 'the tenant must pay rent', verified: true }],
          answer: [{ text: 'The tenant must pay rent.', cites: ['PA1'] }],
          parts: [
            { heading: null, sentences: [{ text: 'The tenant must pay rent.', cites: ['PA1'] }], notStated: false, truncated: true, error: null },
          ],
          truncated: true,
          chunksTotal: 1,
          chunksDone: 1,
          failedChunks: [],
        },
      }),
    );
    const pr = model.sections.find((s) => s.key === 'promptResult') as Extract<(typeof model.sections)[number], { key: 'promptResult' }>;
    expect(pr.parts![0].truncated).toBe(true);
    expect(pr.truncatedNote).toBe(PROMPT_TRUNCATED_NOTE);
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
