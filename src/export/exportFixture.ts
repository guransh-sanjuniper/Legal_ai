import type { Citation, ClauseView, ReportModel, ReportSection, RiskRow } from '../analysis/reportModel';
import { LAW_LABEL } from '../analysis/reportModel';

// Synthetic report used by the export tests and the render script. Neutral content only: an
// equipment supply contract. Nothing here comes from any reference report.

const c = (clause: string, page: number, quote: string): Citation => ({ clause, page, quote });

const clauseView = (over: Partial<ClauseView> & { clauseNo: string }): ClauseView => ({
  key: `clause:${over.clauseNo}`,
  unplaced: false,
  type: 'supply',
  pageStart: 1,
  pageEnd: 1,
  topPriority: null,
  riskCount: 0,
  rows: [{ label: 'Summary', text: 'The supplier delivers the equipment.', items: [], citations: [], modelWritten: true, conditional: false }],
  sourceEntries: 1,
  ...over,
});

const risk = (over: Partial<RiskRow> & { priority: RiskRow['priority'] }): RiskRow => ({
  clause: '1',
  pages: 'page 1',
  issue: 'Issue text.',
  laws: ['Indian Contract Act 1872'],
  suggestion: 'Raise it in negotiation.',
  kind: 'risk',
  citation: c('1', 1, 'a quote'),
  ...over,
});

export function fixtureModel(opts: { withPrompt?: boolean; clauses?: number } = {}): ReportModel {
  const n = opts.clauses ?? 3;
  const clauses: ClauseView[] = Array.from({ length: n }, (_, i) => {
    const no = String(i + 1);
    return clauseView({
      clauseNo: no,
      pageStart: i + 1,
      pageEnd: i + 1,
      type: i === 0 ? 'payment terms' : 'supply',
      topPriority: i === 1 ? 'medium' : null,
      riskCount: i === 1 ? 1 : 0,
      rows: [
        { label: 'Summary', text: `Summary of clause ${no}.`, items: [], citations: [], modelWritten: true, conditional: false },
        { label: 'Detailed summary', text: `Detail of clause ${no}.`, items: [], citations: [], modelWritten: true, conditional: false },
        {
          label: 'Obligations',
          text: null,
          items: [`Supplier: deliver on time`],
          citations: [c(no, i + 1, `delivery quote ${no}`)],
          modelWritten: false,
          conditional: false,
        },
        {
          label: 'Dates',
          text: null,
          items: ['Delivery date (fixed)'],
          citations: [c(no, i + 1, `date quote ${no}`)],
          modelWritten: false,
          conditional: false,
        },
        {
          label: 'Law references',
          text: null,
          items: ['Indian Contract Act 1872'],
          citations: [],
          modelWritten: true,
          conditional: false,
        },
        {
          label: 'Quoted text',
          text: null,
          items: [],
          citations: [c(no, i + 1, `verified quote ${no}`)],
          modelWritten: false,
          conditional: false,
        },
      ],
    });
  });

  const overview = [
    'Nature and Purpose',
    'Parties and Their Roles',
    'Subject Matter / Property and Key Particulars',
    'Commercial Terms',
    'Timeline and Milestones',
    'Obligations by Party',
    'Rights and Protections by Party',
    'Risk Allocation',
    'Termination and Exit',
    'Dispute Resolution, Governing Law, Jurisdiction',
    'Statutory Compliance',
    'Notable Drafting Issues',
    'Internal Inconsistencies',
    'Executive Summary',
  ];

  const sections: ReportSection[] = [];
  sections.push({
    key: 'overview',
    title: 'Overview',
    number: 0,
    points: overview.map((title, i) => ({
      title,
      note: i === 13 ? 'Assembled from cited sentences above.' : undefined,
      sentences: [{ text: `${title} is stated.`, citations: [c('1', 1, 'a verified quote')] }],
    })),
  });
  if (opts.withPrompt) {
    sections.push({
      key: 'promptResult',
      title: 'Prompt Result',
      number: 0,
      prompt: 'Is there a delivery deadline?',
      answers: [
        { text: 'Yes, delivery is due within thirty days.', citation: c('2', 2, 'within thirty days of the order'), part: 'answer' },
        { text: 'Support.', citation: c('2', 2, 'within thirty days of the order'), part: 'support' },
      ],
      failed: [],
      chunksDone: 2,
      chunksTotal: 2,
    });
  }
  sections.push({ key: 'clauses', title: 'Clause Breakdown', number: 0 });
  sections.push({
    key: 'datesAmounts',
    title: 'Dates and Amounts',
    number: 0,
    rows: [{ kind: 'Amount', clause: '1', page: 1, detail: 'Rs. 48,000: Buyer to Supplier, due on delivery', citation: c('1', 1, 'amount quote') }],
  });
  sections.push({
    key: 'obligations',
    title: 'Obligations by Party',
    number: 0,
    groups: [{ party: 'Supplier', rows: [{ clause: '1', page: 1, text: 'Deliver the equipment.', citation: c('1', 1, 'deliver the equipment') }] }],
  });
  sections.push({
    key: 'timeline',
    title: 'Timeline',
    number: 0,
    rows: [{ date: '30 days from the order', event: 'Delivery due.', citation: c('2', 2, 'thirty days') }],
  });
  sections.push({
    key: 'risks',
    title: 'Risk Register',
    number: 0,
    risks: [risk({ priority: 'medium', clause: '2', pages: 'page 2', issue: 'A late-delivery penalty runs one way only.' })],
    missing: [
      risk({
        priority: 'medium',
        clause: 'Whole document',
        pages: '',
        issue: 'governing law: No governing law or forum is named.',
        kind: 'missing',
        citation: null,
        suggestion: 'Add a governing law and forum clause.',
        laws: ['Indian Contract Act 1872'],
      }),
    ],
  });
  sections.push({
    key: 'inconsistencies',
    title: 'Internal Inconsistencies',
    number: 0,
    findings: [{ text: 'Two delivery periods are stated.', citations: [c('2', 2, 'thirty days')] }],
  });
  sections.push({
    key: 'coverage',
    title: 'Coverage',
    number: 0,
    lines: ['Chunks analysed 2 of 2; pages covered 4 of 4.', 'Failed clause units: 0.'],
  });

  const numbered = sections.map((s, i) => ({ ...s, number: i + 1 }) as ReportSection);
  return {
    title: {
      matter: 'Sample matter',
      document: 'sample-supply.pdf',
      reviewDate: '2024-05-12',
      detailLevel: 'standard',
      focus: 'delivery risk',
      reviewingFor: 'licensee',
    },
    banner: [],
    toc: numbered.map((s) => ({ number: s.number, title: s.title, key: s.key })),
    sections: numbered,
    clauses,
    merge: { entries: clauses.length, numberedEntries: clauses.length, placed: 0, merged: 0, unmerged: 0, rows: clauses.length },
  };
}

export const FIXTURE_LAW_LABEL = LAW_LABEL;
