import { describe, it, expect } from 'vitest';
import { OVERVIEW_POINTS, STATUTORY_POINT, buildClausePrompt, buildOverviewPrompt, buildMissingPrompt } from './prompts';
import { EXECUTIVE_FALLBACK_NOTE, assembleOverviewPoints, keepPointSentences, lawsEngaged, statutorySentences } from './overviewPoints';
import type { MissingProtection, VerifiedClause } from './types';

const clause = (clauseNo: string, itemId: string, laws: string[][]): VerifiedClause => ({
  itemId,
  clauseNo,
  type: 'other',
  summary: 's',
  chunkId: 'analysis:0',
  chunkIndex: 0,
  pageStart: 1,
  pageEnd: 1,
  obligations: [],
  dates: [],
  payments: [],
  verifiedItems: laws.length,
  risks: laws.map((l, i) => ({
    itemId: `${itemId}:r${i}`,
    clause: clauseNo,
    text: 't',
    severity: 'medium' as const,
    basis: 'other' as const,
    suggestion: 'x',
    laws: l,
    page: 1,
    quote: 'q',
    verified: true as const,
    applicability: 'unverified' as const,
  })),
});

describe('overview points', () => {
  it('has the thirteen fixed points in order, with no Risk Allocation point', () => {
    expect(OVERVIEW_POINTS).toHaveLength(13);
    expect(OVERVIEW_POINTS[STATUTORY_POINT - 1]).toBe('Statutory Compliance');
    expect(OVERVIEW_POINTS[12]).toBe('Executive Summary');
    expect(OVERVIEW_POINTS).not.toContain('Risk Allocation');
  });

  it('builds Statutory Compliance from laws, labelled as model knowledge, with no page', () => {
    const clauses = [clause('3', 'C1:1:3', [['Act A', 'Act B'], ['act a']]), clause('7', 'C2:1:7', [['Act A']])];
    const laws = lawsEngaged(clauses, []);
    expect(laws[0].name).toBe('Act A');
    expect(laws[0].itemIds).toHaveLength(3);
    const points = assembleOverviewPoints({ model: [], statutory: statutorySentences(laws), inconsistencies: [], notable: [] });
    const statutory = points[STATUTORY_POINT - 1];
    expect(statutory.sentences.map((s) => s.text).join(' ')).toMatch(/model knowledge, applicability unverified/);
    expect(statutory.sentences.some((s) => /page/i.test(s.text))).toBe(false);
  });

  it('says so when no law was named', () => {
    const points = assembleOverviewPoints({ model: [], statutory: statutorySentences([]), inconsistencies: [], notable: [] });
    expect(points[STATUTORY_POINT - 1].sentences[0].cites).toEqual([]);
  });

  it('counts missing-protection laws too', () => {
    const missing: MissingProtection[] = [
      {
        itemId: 'M1',
        topic: 'x',
        text: 'y',
        severity: 'medium',
        basis: 'other',
        suggestion: 'z',
        laws: ['Act C'],
        cites: [],
        applicability: 'unverified',
      },
    ];
    expect(lawsEngaged([], missing)[0]).toMatchObject({ name: 'Act C', itemIds: ['M1'] });
  });

  it('keeps model sentences only for valid points and valid cites', () => {
    const valid = new Set(['C1:1:3', 'M1']);
    const { kept, dropped } = keepPointSentences(
      [
        { point: 4, text: 'Price is set.', cites: ['C1:1:3', 'nope'] },
        { point: 4, text: 'No cite.', cites: [] },
        { point: STATUTORY_POINT, text: 'Model tried point 11.', cites: ['C1:1:3'] },
        { point: 99, text: 'Out of range.', cites: ['C1:1:3'] },
      ],
      valid,
    );
    expect(kept).toEqual([{ point: 4, text: 'Price is set.', cites: ['C1:1:3'] }]);
    expect(dropped).toBeGreaterThan(0);
  });

  it('gives every point an entry, empty when the model wrote nothing', () => {
    const points = assembleOverviewPoints({ model: [{ point: 1, text: 'a', cites: ['C1'] }], statutory: [], inconsistencies: [], notable: [] });
    expect(points).toHaveLength(13);
    expect(points[1].sentences).toEqual([]);
  });

  it('builds Internal Inconsistencies from stored findings, not from the model', () => {
    const points = assembleOverviewPoints({
      model: [{ point: 13, text: 'model wrote this', cites: ['C1'] }],
      statutory: [],
      inconsistencies: [{ text: 'Dates disagree.', cites: ['C1'] }],
      notable: [],
    });
    expect(points[11].sentences).toEqual([{ text: 'Dates disagree.', cites: ['C1'] }]);
  });

  it('assembles Executive Summary from cited sentences and labels it when the model wrote none', () => {
    const points = assembleOverviewPoints({
      model: [
        { point: 1, text: 'It is a licence.', cites: ['C1'] },
        { point: 4, text: 'Fee is set.', cites: ['C2'] },
      ],
      statutory: [],
      inconsistencies: [],
      notable: [],
    });
    const summary = points[12];
    expect(summary.sentences.map((s) => s.text)).toEqual(['It is a licence.', 'Fee is set.']);
    expect(summary.note).toBe(EXECUTIVE_FALLBACK_NOTE);
  });

  it('accepts a point number sent as text', () => {
    const { kept } = keepPointSentences([{ point: '4', text: 'Fee is set.', cites: ['C1'] }], new Set(['C1']));
    expect(kept).toEqual([{ point: 4, text: 'Fee is set.', cites: ['C1'] }]);
  });
});

describe('prompt builders', () => {
  it('states the detail level and the focus only for risks', () => {
    const brief = buildClausePrompt({ docType: null, detail: 'brief', focus: 'payment security' });
    const detailed = buildClausePrompt({ docType: null, detail: 'detailed' });
    expect(brief).toMatch(/detailed_summary: at most 2 sentences/);
    expect(detailed).toMatch(/detailed_summary: at most 7 sentences/);
    expect(brief.match(/FOCUS FOR RISKS ONLY/g)).toHaveLength(1);
    expect(detailed).not.toMatch(/FOCUS FOR RISKS ONLY/);
  });

  it('asks for the Missing column and the risk fields in the clause call', () => {
    const p = buildClausePrompt({ docType: null, detail: 'standard' });
    expect(p).toMatch(/"missing":\["\.\.\."\]/);
    expect(p).toMatch(/"priority":"high"\|"medium"\|"low"/);
    expect(p).toMatch(/ACTS TO CONSIDER FIRST/);
  });

  it('keeps the code-built and focused points out of the main overview prompt', () => {
    const p = buildOverviewPrompt('standard');
    expect(p).not.toMatch(/10 Statutory Compliance/);
    expect(p).not.toMatch(/11 Notable Drafting Issues/);
    expect(p).not.toMatch(/12 Internal Inconsistencies/);
    expect(p).not.toMatch(/8 Termination and Exit/);
    expect(p).not.toMatch(/9 Dispute Resolution/);
    expect(p).toMatch(/7 Rights and Protections/);
  });

  it('puts Notable Drafting Issues in point 11 from the code-built list', () => {
    const points = assembleOverviewPoints({
      model: [],
      statutory: [],
      inconsistencies: [],
      notable: [{ text: 'Unfilled blanks (2).', cites: [] }],
    });
    expect(points[10].sentences).toEqual([{ text: 'Unfilled blanks (2).', cites: [] }]);
  });

  it('puts the focus in the missing-protections prompt', () => {
    expect(buildMissingPrompt({ focus: 'tenant deposits' })).toMatch(/tenant deposits/);
    expect(buildMissingPrompt()).not.toMatch(/FOCUS FOR RISKS ONLY/);
    expect(buildMissingPrompt({ reviewingFor: 'licensor' })).toMatch(/REVIEWING FOR: the licensor/);
  });
});
