import { quoteOverlap } from './judgement';
import { OVERVIEW_POINTS } from './prompts';
import { NO_SUGGESTION, normaliseMissing, sortByPriority, sortByPriorityOf, type RiskPriority } from './rubric';
import type {
  AnalysisReport,
  ClauseProse,
  MissingProtection,
  VerifiedClause,
  VerifiedDate,
  VerifiedObligation,
  VerifiedPayment,
  VerifiedRisk,
} from './types';

// Pure report model. The screen and the Stage C exports both read from this, so they cannot drift.
// Everything shown comes from the stored report; nothing here is written by the model.

export const REPORT_FOOTER = 'AI-assisted, requires lawyer review';
export const LAW_LABEL = 'model knowledge, applicability unverified';
export const NOT_STATED = 'Not stated in the document';

export interface Citation {
  page: number;
  quote: string;
  clause: string;
}

export interface ClauseRowView {
  label: string;
  text: string | null;
  items: string[];
  citations: Citation[];
  modelWritten: boolean;
  // Conditional rows are left out of the table when they have no content.
  conditional: boolean;
}

export interface ClauseView {
  key: string;
  clauseNo: string;
  unplaced: boolean;
  type: string;
  pageStart: number;
  pageEnd: number;
  topPriority: RiskPriority | null;
  riskCount: number;
  rows: ClauseRowView[];
  // null for reports saved before the Missing column existed.
  missing: string[] | null;
  // How many stored entries were combined into this row.
  sourceEntries: number;
}

export interface MergeStats {
  entries: number;
  numberedEntries: number;
  // Unnumbered entries that were given a clause number from their quotes or their chunk's clause list.
  placed: number;
  // Numbered entries combined into another row for the same clause.
  merged: number;
  // Entries that could not be placed. They stay as separate rows and are never dropped.
  unmerged: number;
  rows: number;
}

export interface RiskRow {
  priority: RiskPriority;
  clause: string;
  pages: string;
  issue: string;
  laws: string[];
  suggestion: string;
  kind: 'risk' | 'missing';
  // The quote behind a risk, or the first affected clause for a missing protection. Null when there is none.
  citation: Citation | null;
}

export interface TimelineRow {
  date: string;
  event: string;
  citation: Citation;
}

export type SectionKey =
  | 'overview'
  | 'promptResult'
  | 'clauses'
  | 'datesAmounts'
  | 'obligations'
  | 'timeline'
  | 'risks'
  | 'inconsistencies'
  | 'coverage';

interface SectionBase<K extends SectionKey> {
  key: K;
  title: string;
  number: number;
}

export type ReportSection =
  | (SectionBase<'overview'> & { points: { title: string; sentences: { text: string; citations: Citation[] }[] }[] })
  | (SectionBase<'promptResult'> & {
      prompt: string;
      answers: { text: string; citation: Citation }[];
      failed: string[];
      chunksDone: number;
      chunksTotal: number;
    })
  | SectionBase<'clauses'>
  | (SectionBase<'datesAmounts'> & {
      rows: { kind: 'Date' | 'Amount'; clause: string; page: number; detail: string; citation: Citation }[];
    })
  | (SectionBase<'obligations'> & {
      groups: { party: string; rows: { clause: string; page: number; text: string; citation: Citation }[] }[];
    })
  | (SectionBase<'timeline'> & { rows: TimelineRow[] })
  | (SectionBase<'risks'> & { risks: RiskRow[]; missing: RiskRow[] })
  | (SectionBase<'inconsistencies'> & { findings: { text: string; citations: Citation[] }[] })
  | (SectionBase<'coverage'> & { lines: string[] });

export interface ReportModel {
  title: { matter: string; document: string; reviewDate: string; detailLevel: string; focus: string };
  banner: string[];
  toc: { number: number; title: string; key: SectionKey }[];
  sections: ReportSection[];
  clauses: ClauseView[];
  merge: MergeStats;
}

const TITLES: Record<SectionKey, string> = {
  overview: 'Overview',
  promptResult: 'Prompt Result',
  clauses: 'Clause Breakdown',
  datesAmounts: 'Dates and Amounts',
  obligations: 'Obligations by Party',
  timeline: 'Timeline',
  risks: 'Risk Register',
  inconsistencies: 'Internal Inconsistencies',
  coverage: 'Coverage',
};

// ---------- clause numbers and placement ----------

export function normaliseClauseNo(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(clause|section|article|sec\.?|cl\.?)\s*/, '')
    .replace(/[\s.]+$/, '')
    .replace(/\s+/g, '')
    .trim();
}

// A clause number contains a digit. Type labels ("risks", "obligations") and "#n" placeholders do not.
export function hasOwnNumber(s: string | null | undefined): boolean {
  return typeof s === 'string' && /\d/.test(s) && !s.trim().startsWith('#');
}

export type ChunkClauseMap = Map<number, string[]>;

export function chunkClauseMap(report: AnalysisReport): ChunkClauseMap {
  const map: ChunkClauseMap = new Map();
  if (report.chunkClauses) {
    for (const c of report.chunkClauses) map.set(c.chunkIndex, c.clauses);
    return map;
  }
  // Reports saved before chunkClauses existed: the numbered clauses stored on the same chunk.
  for (const c of report.clauses) {
    if (!hasOwnNumber(c.clauseNo)) continue;
    map.set(c.chunkIndex, [...(map.get(c.chunkIndex) ?? []), c.clauseNo]);
  }
  return map;
}

// Returns the clause key an entry belongs to, or null when it cannot be placed.
// Order: its own number; then the most common clause number on its verified quotes (a clear
// winner only); then the chunk's clause list when that names exactly one clause.
export function placeEntry(
  entry: VerifiedClause,
  chunks: ChunkClauseMap,
): { key: string | null; how: 'own' | 'quotes' | 'chunk' | null } {
  if (hasOwnNumber(entry.clauseNo)) return { key: normaliseClauseNo(entry.clauseNo), how: 'own' };

  const counts = new Map<string, number>();
  for (const it of [...entry.obligations, ...entry.dates, ...entry.payments, ...entry.risks]) {
    if (!hasOwnNumber(it.clause)) continue;
    const key = normaliseClauseNo(it.clause);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) {
    return { key: ranked[0][0], how: 'quotes' };
  }

  const inChunk = [...new Set((chunks.get(entry.chunkIndex) ?? []).filter(hasOwnNumber).map(normaliseClauseNo))];
  if (inChunk.length === 1) return { key: inChunk[0], how: 'chunk' };

  return { key: null, how: null };
}

// Items repeated across merged entries (same page, overlapping quote) are kept once.
function mergeItems<T extends { page: number; quote: string }>(lists: T[][]): T[] {
  const out: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (!out.some((x) => x.page === item.page && quoteOverlap(x.quote, item.quote))) out.push(item);
    }
  }
  return out;
}

// Merge rule for text: the longest non-empty value per field wins. Nothing is joined, so no text
// is repeated, and the longest value is the most complete one. Lists are unions.
export function longestOf(values: (string | undefined | null)[]): string {
  let best = '';
  for (const v of values) {
    const t = (v ?? '').trim();
    if (t.length > best.length) best = t;
  }
  return best;
}

function mergeProse(entries: VerifiedClause[]): ClauseProse | undefined {
  const withProse = entries.filter((e) => e.prose);
  if (withProse.length === 0) return undefined;
  const keys = Object.keys(withProse[0].prose!) as (keyof ClauseProse)[];
  const out = {} as ClauseProse;
  for (const k of keys) out[k] = longestOf(withProse.map((e) => e.prose![k]));
  return out;
}

function mergeGroup(key: string, entries: VerifiedClause[]): VerifiedClause {
  const risks = sortByPriority(mergeItems<VerifiedRisk>(entries.map((e) => e.risks)));
  const obligations = mergeItems<VerifiedObligation>(entries.map((e) => e.obligations));
  const dates = mergeItems<VerifiedDate>(entries.map((e) => e.dates));
  const payments = mergeItems<VerifiedPayment>(entries.map((e) => e.payments));
  return {
    itemId: `clause:${key}`,
    clauseNo: longestOf(entries.map((e) => e.clauseNo)) || key,
    type: longestOf(entries.map((e) => e.type)),
    summary: longestOf(entries.map((e) => e.summary)),
    chunkId: entries[0].chunkId,
    chunkIndex: entries[0].chunkIndex,
    pageStart: Math.min(...entries.map((e) => e.pageStart)),
    pageEnd: Math.max(...entries.map((e) => e.pageEnd)),
    obligations,
    dates,
    payments,
    risks,
    verifiedItems: obligations.length + dates.length + payments.length + risks.length,
    missing: entries.some((e) => e.missing !== undefined) ? normaliseMissing(entries.flatMap((e) => e.missing ?? [])) : undefined,
    prose: mergeProse(entries),
  };
}

export interface MergedClause {
  clause: VerifiedClause;
  unplaced: boolean;
  sources: number;
}

export function mergeClauses(report: AnalysisReport): { rows: MergedClause[]; stats: MergeStats } {
  const chunks = chunkClauseMap(report);
  const groups = new Map<string, VerifiedClause[]>();
  const unplacedEntries: VerifiedClause[] = [];
  let placed = 0;
  let numbered = 0;
  for (const entry of report.clauses) {
    if (hasOwnNumber(entry.clauseNo)) numbered++;
    const p = placeEntry(entry, chunks);
    if (p.how === 'quotes' || p.how === 'chunk') placed++;
    if (!p.key) {
      unplacedEntries.push(entry);
      continue;
    }
    groups.set(p.key, [...(groups.get(p.key) ?? []), entry]);
  }
  const rows: MergedClause[] = [
    ...[...groups.entries()].map(([key, list]) => ({ clause: mergeGroup(key, list), unplaced: false, sources: list.length })),
    ...unplacedEntries.map((e) => ({ clause: e, unplaced: true, sources: 1 })),
  ];
  const placedEntries = report.clauses.length - unplacedEntries.length;
  const stats: MergeStats = {
    entries: report.clauses.length,
    numberedEntries: numbered,
    placed,
    merged: placedEntries - groups.size,
    unmerged: unplacedEntries.length,
    rows: rows.length,
  };
  return { rows: rows.sort((a, b) => a.clause.pageStart - b.clause.pageStart || a.clause.clauseNo.localeCompare(b.clause.clauseNo)), stats };
}

// ---------- clause table ----------

const cite = (page: number, quote: string, clause: string): Citation => ({ page, quote, clause });
const dateLabel = (d: VerifiedDate) => `${d.text} (${d.timing_type.replace('_', ' ')})`;
const paymentLabel = (p: VerifiedPayment) =>
  `${p.amount}: ${p.payer || 'payer not named'} to ${p.payee || 'payee not named'}${p.due ? `, due ${p.due}` : ''}`;

function clauseView(m: MergedClause): ClauseView {
  const c = m.clause;
  const risks = sortByPriority(c.risks);
  const top = risks[0];
  const prose = c.prose;
  const laws = [...new Set(risks.flatMap((r) => r.laws ?? []))];
  const quotes: Citation[] = [
    ...c.obligations.map((o) => cite(o.page, o.quote, c.clauseNo)),
    ...c.dates.map((d) => cite(d.page, d.quote, c.clauseNo)),
    ...c.payments.map((p) => cite(p.page, p.quote, c.clauseNo)),
    ...risks.map((r) => cite(r.page, r.quote, c.clauseNo)),
  ];
  const text = (label: string, value: string | null | undefined, conditional = false): ClauseRowView => ({
    label,
    text: value && value.trim() ? value.trim() : null,
    items: [],
    citations: [],
    modelWritten: true,
    conditional,
  });
  const list = (label: string, items: string[], citations: Citation[], opts: { modelWritten?: boolean; conditional?: boolean } = {}): ClauseRowView => ({
    label,
    text: null,
    items,
    citations,
    modelWritten: opts.modelWritten ?? false,
    conditional: opts.conditional ?? false,
  });

  const rows: ClauseRowView[] = [
    text('Summary', c.summary),
    text('Detailed summary', prose?.detailed_summary),
    text('Conditions & triggers', prose?.conditions),
    text('Exceptions & carve-outs', prose?.exceptions),
    text('Rights', prose?.rights),
    list('Obligations', c.obligations.map((o) => `${o.party || 'Party not named'}: ${o.text}`), c.obligations.map((o) => cite(o.page, o.quote, c.clauseNo))),
    list('Dates', c.dates.map(dateLabel), c.dates.map((d) => cite(d.page, d.quote, c.clauseNo)), { conditional: true }),
    list('Amounts', c.payments.map(paymentLabel), c.payments.map((p) => cite(p.page, p.quote, c.clauseNo)), { conditional: true }),
    text('Legal significance', prose?.legal_significance),
    text('Ambiguity / drafting issues', prose?.ambiguity),
    list('Law references', laws, [], { modelWritten: true }),
    text('Risk note', top?.text),
    text('Suggested action', prose?.suggested_action || (top ? top.suggestion || NO_SUGGESTION : null)),
    list('Quoted text', [], quotes),
    text('Location mismatch', prose?.location_mismatch, true),
  ];

  return {
    key: c.itemId,
    clauseNo: c.clauseNo,
    unplaced: m.unplaced,
    type: c.type,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    topPriority: risks.length ? risks[0].severity : null,
    riskCount: risks.length,
    rows: rows.filter((r) => !r.conditional || r.text !== null || r.items.length > 0),
    missing: c.missing === undefined ? null : c.missing,
    sourceEntries: m.sources,
  };
}

// ---------- sections ----------

function pageLabel(start: number, end: number): string {
  return start === end ? `page ${start}` : `pages ${start}–${end}`;
}

export function buildReportModel(report: AnalysisReport): ReportModel {
  const { rows, stats } = mergeClauses(report);
  const clauses = rows.map(clauseView);
  const all = rows.map((r) => r.clause);

  // Every stored citation id resolves to a quote and page. Missing protections cite clauses by item id.
  const byId = new Map<string, Citation>();
  for (const c of all) {
    for (const i of [...c.obligations, ...c.dates, ...c.payments, ...c.risks]) byId.set(i.itemId, cite(i.page, i.quote, c.clauseNo));
  }
  const clauseById = new Map<string, VerifiedClause>();
  for (const c of all) clauseById.set(c.itemId, c);
  for (const c of report.clauses) if (!clauseById.has(c.itemId)) clauseById.set(c.itemId, c);
  const resolve = (ids: string[]): Citation[] =>
    ids.flatMap((id) => {
      const found = byId.get(id);
      if (found) return [found];
      const c = clauseById.get(id);
      return c ? [cite(c.pageStart, '', c.clauseNo)] : [];
    });

  const sections: ReportSection[] = [];

  // Overview: fourteen points. Older reports without points show the points with no sentences.
  const points = report.overviewPoints;
  sections.push({
    key: 'overview',
    title: TITLES.overview,
    number: 0,
    points: (points ?? OVERVIEW_POINTS.map((title, i) => ({ point: i + 1, title, sentences: [] }))).map((p) => ({
      title: p.title,
      sentences: p.sentences.map((s) => ({ text: s.text, citations: resolve(s.cites) })),
    })),
  });

  if (report.promptResult) {
    const pr = report.promptResult;
    sections.push({
      key: 'promptResult',
      title: TITLES.promptResult,
      number: 0,
      prompt: pr.prompt,
      answers: pr.answers.map((a) => ({ text: a.text, citation: cite(a.page, a.quote, a.clause) })),
      failed: pr.failedChunks.map((f) => `pages ${f.pages[0]}–${f.pages[1]}: ${f.message ?? f.failureCode ?? 'not completed'}`),
      chunksDone: pr.chunksDone,
      chunksTotal: pr.chunksTotal,
    });
  }

  sections.push({ key: 'clauses', title: TITLES.clauses, number: 0 });

  const amountRows: Extract<ReportSection, { key: 'datesAmounts' }>['rows'] = [];
  for (const c of all) {
    for (const d of c.dates) amountRows.push({ kind: 'Date', clause: c.clauseNo, page: d.page, detail: dateLabel(d), citation: cite(d.page, d.quote, c.clauseNo) });
    for (const p of c.payments) amountRows.push({ kind: 'Amount', clause: c.clauseNo, page: p.page, detail: paymentLabel(p), citation: cite(p.page, p.quote, c.clauseNo) });
  }
  sections.push({ key: 'datesAmounts', title: TITLES.datesAmounts, number: 0, rows: amountRows });

  const groups = new Map<string, { party: string; rows: { clause: string; page: number; text: string; citation: Citation }[] }>();
  for (const c of all) {
    for (const o of c.obligations) {
      const party = o.party.trim() || 'Party not named';
      const g = groups.get(party.toLowerCase()) ?? { party, rows: [] };
      g.rows.push({ clause: c.clauseNo, page: o.page, text: o.text, citation: cite(o.page, o.quote, c.clauseNo) });
      groups.set(party.toLowerCase(), g);
    }
  }
  sections.push({ key: 'obligations', title: TITLES.obligations, number: 0, groups: [...groups.values()] });

  const timeline: TimelineRow[] = [];
  for (const c of all) {
    for (const d of c.dates) {
      timeline.push({ date: d.text, event: c.summary || c.type || `Clause ${c.clauseNo}`, citation: cite(d.page, d.quote, c.clauseNo) });
    }
  }
  // Dates that parse are sorted; the others keep their document order after them.
  const parse = (s: string) => {
    const t = Date.parse(s.replace(/(\d+)(st|nd|rd|th)\b/i, '$1'));
    return Number.isNaN(t) ? null : t;
  };
  timeline.sort((a, b) => {
    const pa = parse(a.date);
    const pb = parse(b.date);
    if (pa !== null && pb !== null) return pa - pb;
    if (pa !== null) return -1;
    if (pb !== null) return 1;
    return 0;
  });
  sections.push({ key: 'timeline', title: TITLES.timeline, number: 0, rows: timeline });

  const riskRows: RiskRow[] = [];
  for (const c of all) {
    for (const r of c.risks) {
      riskRows.push({
        priority: r.severity,
        clause: c.clauseNo,
        pages: pageLabel(r.page, r.page),
        issue: r.text,
        laws: r.laws ?? [],
        suggestion: r.suggestion || NO_SUGGESTION,
        kind: 'risk',
        citation: cite(r.page, r.quote, c.clauseNo),
      });
    }
  }
  const missingRows: RiskRow[] = (report.missingProtections ?? []).map((m: MissingProtection) => {
    const affected = resolve(m.cites);
    return {
      priority: m.severity,
      clause: affected.length ? [...new Set(affected.map((a) => a.clause))].join(', ') : 'Whole document',
      pages: affected.length ? pageLabel(Math.min(...affected.map((a) => a.page)), Math.max(...affected.map((a) => a.page))) : '',
      issue: `${m.topic}: ${m.text}`,
      laws: m.laws,
      suggestion: m.suggestion || NO_SUGGESTION,
      kind: 'missing',
      citation: affected[0] ?? null,
    };
  });
  sections.push({
    key: 'risks',
    title: TITLES.risks,
    number: 0,
    risks: sortByPriorityOf(riskRows, (r) => r.priority),
    missing: sortByPriorityOf(missingRows, (r) => r.priority),
  });

  const findings = report.crossClause.findings
    .filter((f) => f.kind !== 'gap')
    .map((f) => ({ text: f.text, citations: resolve(f.itemIds) }));
  sections.push({ key: 'inconsistencies', title: TITLES.inconsistencies, number: 0, findings });

  // TODO: remove before final product (coverage is a testing aid).
  const totals = report.ledger.totals;
  const cov = report.coverage;
  const lines = [
    `Clauses detected ${totals.clausesDetected}; analysed ${totals.clausesAnalysed}; not analysed ${totals.clausesSkipped}.`,
    cov?.totalChunks !== undefined
      ? `Chunks analysed ${cov.analysedChunks ?? 0} of ${cov.totalChunks}; pages covered ${cov.pagesCovered ?? 0} of ${cov.totalPages ?? 0}.`
      : '',
    `Failed clause units: ${report.failedClauses?.length ?? 0}.`,
  ].filter(Boolean);
  sections.push({ key: 'coverage', title: TITLES.coverage, number: 0, lines });

  const numbered = sections.map((s, i) => ({ ...s, number: i + 1 }) as ReportSection);
  const r = report.request;
  return {
    title: {
      matter: r?.matter || '—',
      document: report.docName,
      reviewDate: new Date(report.createdAt).toLocaleDateString('en-GB'),
      detailLevel: r?.detailLevel ?? 'standard',
      focus: r?.focus || '—',
    },
    banner: report.partial || report.unreliable ? report.notices.filter((n) => /partial|unreliable|not analysed|could not be checked|incomplete/i.test(n)) : [],
    toc: numbered.map((s) => ({ number: s.number, title: s.title, key: s.key })),
    sections: numbered,
    clauses,
    merge: stats,
  };
}
