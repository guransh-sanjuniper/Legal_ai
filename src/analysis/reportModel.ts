import { quoteOverlap } from './judgement';
import { OVERVIEW_POINTS } from './prompts';
import { NO_SUGGESTION, normaliseMissing, sortByPriority, sortByPriorityOf, type RiskPriority } from './rubric';
import { limitSupporting, rankPromptAnswers } from './supportingSources';
import { NOT_CLEAR_ANSWER, type AnalysisReport, type ClauseProse, type MissingProtection, type OverviewPoint, type VerifiedClause, type VerifiedDate, type VerifiedObligation, type VerifiedPayment, type VerifiedRisk } from './types';

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

// One sentence of the on-screen Prompt Result answer. Markers are source numbers, in the order the
// sentence cites them; the same numbers appear in the Sources list and in every renderer.
export interface PromptResultSentenceView {
  text: string;
  style: 'paragraph' | 'bullet';
  markers: number[];
  citations: Citation[];
}

// One part of the answer: the user's own wording when the request had several parts, else null.
export interface PromptResultPartView {
  heading: string | null;
  sentences: PromptResultSentenceView[];
  notStated: boolean;
  truncated: boolean;
  error: string | null;
}

// A numbered source: the verified quote behind one marker. Unverified quotes never reach this list.
export interface PromptSourceView {
  n: number;
  clause: string;
  page: number;
  quote: string;
  citation: Citation;
}

export interface PromptResultStatsView {
  // Distinct verified passages cited by the answer, and the page range they cover.
  cited: number;
  pageStart: number | null;
  pageEnd: number | null;
  // Verified quotes the guards kept out of the evidence, and how much was read for coverage.
  excluded: number;
  readSections: number | null;
  moreSections: number | null;
}

export const PROMPT_TRUNCATED_NOTE =
  'The answer was cut off at the output limit and may be incomplete. Ask again for the remaining points, or split the request into separate questions.';

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
  // Which party the term affects. Neutral reviewing leaves it as the document states it.
  affects: string;
  pages: string;
  issue: string;
  laws: string[];
  suggestion: string;
  kind: 'risk' | 'missing';
  // The quote behind a risk, or the first affected clause for a missing protection. Null when there is none.
  citation: Citation | null;
}

// Dates: date, what it is, fixed or relative, clause, source.
export interface DateRow {
  date: string;
  purpose: string;
  timing: 'fixed' | 'relative';
  clause: string;
  citation: Citation;
}

// Amounts: amount, what it is for, payer to payee, when due, clause, source.
export interface AmountRow {
  amount: string;
  purpose: string;
  payerToPayee: string;
  due: string;
  clause: string;
  citation: Citation;
}

export type SectionKey =
  | 'overview'
  | 'promptResult'
  | 'clauses'
  | 'datesAmounts'
  | 'obligations'
  | 'risks'
  | 'inconsistencies'
  | 'coverage';
interface SectionBase<K extends SectionKey> {
  key: K;
  title: string;
  number: number;
}

export type ReportSection =
  | (SectionBase<'overview'> & {
      points: { title: string; note?: string; sentences: { text: string; citations: Citation[] }[] }[];
    })
  | (SectionBase<'promptResult'> & {
      prompt: string;
      // How the answer was produced, and how many sections were read.
      modeLine: string | null;
      canScanWhole: boolean;
      // Set when the write-up call failed; the quotes are still shown.
      error: string | null;
      // One answer in prose. Sentences cite verified chunk answers.
      // Kept unchanged: the DOCX and HTML exports render from these three fields.
      answer: { text: string; citations: Citation[] }[];
      // Supporting quotes, grouped by clause. Capped; the uncapped rest is counted in sourcesMore.
      groups: { clause: string; quotes: { quote: string; citation: Citation }[] }[];
      sourcesMore: number;
      // On-screen layout only. Numbered markers in the text, one numbered source row per quote.
      // Optional so the export fixture (src/export) stays untouched; the exports never read them.
      parts?: PromptResultPartView[];
      sources?: PromptSourceView[];
      stats?: PromptResultStatsView | null;
      truncatedNote?: string | null;
      failed: string[];
      chunksDone: number;
      chunksTotal: number;
    })
  | SectionBase<'clauses'>
  | (SectionBase<'datesAmounts'> & { dates: DateRow[]; amounts: AmountRow[] })
  | (SectionBase<'obligations'> & {
      groups: { party: string; rows: { clause: string; page: number; text: string; citation: Citation }[] }[];
    })
  | (SectionBase<'risks'> & {
      risks: RiskRow[];
      missing: RiskRow[];
      possiblyMissing: RiskRow[];
      reviewLine: string | null;
      missingLine: string | null;
      drops: { clause: string; issue: string; reason: string }[];
      missingDrops: { topic: string; page: number }[];
    })
  | (SectionBase<'inconsistencies'> & { findings: { text: string; citations: Citation[] }[] })
  | (SectionBase<'coverage'> & { lines: string[] });

export interface ReportModel {
  title: { matter: string; document: string; reviewDate: string; detailLevel: string; focus: string; reviewingFor: string };
  banner: string[];
  // Shown in its own banner: the document was prepared with pages not reviewed by a person.
  unreviewed: string | null;
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
// Labels from the model can contain underscores ("payment_terms"); show them as words.
export function cleanLabel(s: string): string {
  return s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

// Natural order for clause numbers: 2 before 10, and 3.2 before 3.10.
export function compareClauseNo(a: string, b: string): number {
  const parts = (s: string) => normaliseClauseNo(s).match(/\d+|\D+/g) ?? [];
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else {
      const c = x.localeCompare(y);
      if (c !== 0) return c;
    }
  }
  return 0;
}

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
  const text = (label: string, value: string | null | undefined): ClauseRowView => ({
    label,
    text: value && value.trim() ? value.trim() : null,
    items: [],
    citations: [],
    modelWritten: true,
    conditional: false,
  });
  const list = (label: string, items: string[], citations: Citation[], modelWritten = false): ClauseRowView => ({
    label,
    text: null,
    items,
    citations,
    modelWritten,
    conditional: false,
  });

  // Summary is always shown. Other rows are shown only when they have content.
  const candidates: ClauseRowView[] = [
    text('Summary', c.summary),
    text('Detailed summary', prose?.detailed_summary),
    text('Conditions & triggers', prose?.conditions),
    text('Rights', prose?.rights),
    list('Obligations', c.obligations.map((o) => `${o.party || 'Party not named'}: ${o.text}`), c.obligations.map((o) => cite(o.page, o.quote, c.clauseNo))),
    list('Dates', c.dates.map(dateLabel), c.dates.map((d) => cite(d.page, d.quote, c.clauseNo))),
    list('Amounts', c.payments.map(paymentLabel), c.payments.map((p) => cite(p.page, p.quote, c.clauseNo))),
    text('Legal significance', prose?.legal_significance),
    text('Ambiguity / drafting issues', prose?.ambiguity),
    list('Law references', laws, [], true),
    text('Suggested action', prose?.suggested_action || (top ? top.suggestion || NO_SUGGESTION : null)),
    list('Quoted text', [], quotes),
    text('Location mismatch', prose?.location_mismatch),
  ];
  const rows = candidates.filter((r) => r.label === 'Summary' || r.text !== null || r.items.length > 0 || r.citations.length > 0);

  return {
    key: c.itemId,
    clauseNo: c.clauseNo,
    unplaced: m.unplaced,
    type: cleanLabel(c.type),
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    topPriority: risks.length ? risks[0].severity : null,
    riskCount: risks.length,
    rows,
    sourceEntries: m.sources,
  };
}

// ---------- sections ----------

function pageLabel(start: number, end: number): string {
  return start === end ? `page ${start}` : `pages ${start}–${end}`;
}

export function unreviewedText(pages: number): string | null {
  if (pages <= 0) return null;
  return `${pages} page${pages === 1 ? ' was' : 's were'} not reviewed; OCR text was used as extracted.`;
}

export function buildReportModel(report: AnalysisReport): ReportModel {
  const { rows, stats } = mergeClauses(report);
  // Numbered clauses in numeric order; entries that could not be placed follow them.
  const clauses = rows
    .map(clauseView)
    .sort(
      (a, b) =>
        Number(!hasOwnNumber(a.clauseNo)) - Number(!hasOwnNumber(b.clauseNo)) ||
        compareClauseNo(a.clauseNo, b.clauseNo) ||
        a.pageStart - b.pageStart,
    );
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
  const points: OverviewPoint[] | undefined = report.overviewPoints;
  sections.push({
    key: 'overview',
    title: TITLES.overview,
    number: 0,
    points: (points ?? OVERVIEW_POINTS.map((title, i): OverviewPoint => ({ point: i + 1, title, sentences: [] }))).map((p) => ({
      title: p.title,
      note: p.note,
      sentences: p.sentences.map((s) => ({ text: s.text, citations: resolve(s.cites) })),
    })),
  });

  if (report.promptResult) {
    const pr = report.promptResult;
    const citationOf = (a: { page: number; quote: string; clause: string }) => cite(a.page, a.quote, a.clause);
    const byId = new Map(pr.answers.map((a) => [a.itemId, a]));
    const answer = (pr.answer ?? []).map((s) => ({
      text: s.text,
      citations: s.cites.flatMap((id) => {
        const a = byId.get(id);
        return a ? [citationOf(a)] : [];
      }),
    }));
    // The same quote can come back as both an answer and its support; keep one of each.
    const seenQuotes = new Set<string>();
    const unique = rankPromptAnswers(pr.answers, pr.answer ?? []).filter((a) => {
      const key = `${a.page}|${a.quote}`;
      if (seenQuotes.has(key)) return false;
      seenQuotes.add(key);
      return true;
    });
    const { shown, more } = limitSupporting(unique);
    const grouped = new Map<string, { clause: string; quotes: { quote: string; citation: Citation }[] }>();
    for (const a of shown) {
      const g = grouped.get(a.clause) ?? { clause: a.clause, quotes: [] };
      g.quotes.push({ quote: a.quote, citation: citationOf(a) });
      grouped.set(a.clause, g);
    }

    // On-screen layout: numbered markers in the text and one row per source. Numbering is assigned
    // once, in code, by first appearance, so every renderer shows the same number for a quote.
    const sourceById = new Map<string, number>();
    const sourceRows: PromptSourceView[] = [];
    const numberFor = (id: string): number | null => {
      const existing = sourceById.get(id);
      if (existing) return existing;
      const a = byId.get(id);
      if (!a) return null;
      const n = sourceRows.length + 1;
      sourceById.set(id, n);
      sourceRows.push({ n, clause: a.clause, page: a.page, quote: a.quote, citation: citationOf(a) });
      return n;
    };
    const rawParts = pr.parts?.length
      ? pr.parts
      : (pr.answer ?? []).length > 0
        ? [
            {
              heading: null,
              sentences: (pr.answer ?? []).map((s) => ({ text: s.text, cites: s.cites, style: 'paragraph' as const })),
              notStated: false,
              truncated: false,
              error: null,
            },
          ]
        : [];
    const parts: PromptResultPartView[] = rawParts.map((p) => {
      const sentences: PromptResultSentenceView[] = p.sentences
        .map((s) => {
          const markers = [...new Set(s.cites.map(numberFor).filter((n): n is number => n !== null))];
          return {
            text: s.text,
            style: (s.style === 'bullet' ? 'bullet' : 'paragraph') as 'paragraph' | 'bullet',
            markers,
            citations: markers.map((n) => sourceRows[n - 1].citation),
          };
        })
        .filter((s) => s.text.trim().length > 0);
      // "Not clearly stated" is shown as a muted line, not as a cited sentence.
      const onlyNotClear = sentences.length > 0 && sentences.every((s) => s.markers.length === 0 && s.text.trim() === NOT_CLEAR_ANSWER);
      return {
        heading: p.heading?.trim() || null,
        sentences: onlyNotClear ? [] : sentences,
        notStated: Boolean(p.notStated) || onlyNotClear,
        truncated: Boolean(p.truncated),
        error: p.error ?? null,
      };
    });
    // Nothing written up: the verified quotes are still listed, ranked, and never capped.
    if (parts.every((p) => p.sentences.length === 0)) {
      for (const a of rankPromptAnswers(pr.answers, pr.answer ?? [])) numberFor(a.itemId);
    }
    const pages = sourceRows.map((s) => s.page).filter((n) => Number.isFinite(n) && n > 0);
    const stats: PromptResultStatsView = {
      cited: sourceRows.length,
      pageStart: pages.length ? Math.min(...pages) : null,
      pageEnd: pages.length ? Math.max(...pages) : null,
      excluded: pr.stats?.excluded ?? 0,
      readSections: pr.stats?.readSections ?? null,
      moreSections: pr.stats?.moreSections ?? null,
    };
    const truncated = Boolean(pr.truncated) || parts.some((p) => p.truncated);

    sections.push({
      key: 'promptResult',
      title: TITLES.promptResult,
      number: 0,
      prompt: pr.prompt,
      modeLine:
        pr.mode === 'retrieval'
          ? `Based on the ${pr.selectedChunks ?? 0} most relevant sections of ${pr.chunksTotal}.`
          : pr.mode === 'whole'
            ? `Whole-document scan (${pr.chunksTotal} sections).`
            : pr.mode === 'inline'
              ? pr.stats?.readSections
                ? `Answered from the clause analysis, with ${pr.stats.readSections} extra section${pr.stats.readSections === 1 ? '' : 's'} read for coverage.`
                : 'Answered with the clause analysis, with no extra reading pass.'
              : null,
      canScanWhole: pr.mode === 'retrieval',
      error: pr.error ?? null,
      answer,
      groups: [...grouped.values()],
      sourcesMore: more,
      parts,
      sources: sourceRows,
      stats,
      truncatedNote: truncated ? PROMPT_TRUNCATED_NOTE : null,
      failed: pr.failedChunks.map((f) => `pages ${f.pages[0]}–${f.pages[1]}: ${f.message ?? f.failureCode ?? 'not completed'}`),
      chunksDone: pr.chunksDone,
      chunksTotal: pr.chunksTotal,
    });
  }

  sections.push({ key: 'clauses', title: TITLES.clauses, number: 0 });

  // Dates and amounts are separate tables. A date with no stated purpose and no quote is dropped.
  const dateRows: DateRow[] = [];
  const amountRows: AmountRow[] = [];
  for (const c of all) {
    for (const d of c.dates) {
      const purpose = d.purpose?.trim() || d.quote.trim();
      if (!purpose) continue;
      dateRows.push({
        date: d.text,
        purpose,
        timing: d.timing_type === 'event_relative' ? 'relative' : 'fixed',
        clause: c.clauseNo,
        citation: cite(d.page, d.quote, c.clauseNo),
      });
    }
    for (const p of c.payments) {
      const purpose = p.purpose?.trim() || p.quote.trim();
      if (!purpose) continue;
      amountRows.push({
        amount: p.amount,
        purpose,
        payerToPayee: `${p.payer || 'payer not named'} to ${p.payee || 'payee not named'}`,
        due: p.due,
        clause: c.clauseNo,
        citation: cite(p.page, p.quote, c.clauseNo),
      });
    }
  }
  sections.push({ key: 'datesAmounts', title: TITLES.datesAmounts, number: 0, dates: dateRows, amounts: amountRows });

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
        affects: r.affects?.trim() || 'Both/unclear',
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
      affects: 'Both/unclear',
      citation: affected[0] ?? null,
    };
  });
  const toRow = (m: MissingProtection): RiskRow => ({
    priority: m.severity,
    clause: 'Whole document',
    affects: 'Both/unclear',
    pages: '',
    issue: `${m.topic}: ${m.text}`,
    laws: m.laws,
    suggestion: m.suggestion || NO_SUGGESTION,
    kind: 'missing',
    citation: null,
  });
  const possiblyRows: RiskRow[] = (report.possiblyMissing ?? []).map(toRow);
  const ms = report.missingStats;
  const missingLine = ms
    ? ms.passRan
      ? `${ms.proposed} proposed, ${ms.kept} kept, ${ms.droppedCovered} dropped by search${ms.possiblyMissing ? `, ${ms.possiblyMissing} unverified` : ''}; ` +
        `pass ran: yes; raw items: ${ms.rawItems ?? 0}; rejected by schema: ${ms.rejectedBySchema ?? 0}; ` +
        `tasks done: ${ms.tasksDone ?? 0}, failed: ${ms.tasksFailed ?? 0}.`
      : 'pass ran: no (no verified clauses to check).'
    : null;
  const rr = report.riskReview;
  const reviewLine = rr ? `${rr.reviewed} risks after validation (${rr.dropped} dropped).` : null;
  sections.push({
    key: 'risks',
    title: TITLES.risks,
    number: 0,
    risks: sortByPriorityOf(riskRows, (r) => r.priority),
    missing: sortByPriorityOf(missingRows, (r) => r.priority),
    possiblyMissing: sortByPriorityOf(possiblyRows, (r) => r.priority),
    reviewLine,
    missingLine,
    drops: rr?.drops ?? [],
    missingDrops: (report.missingDrops ?? []).map((d) => ({ topic: d.topic, page: d.page })),
  });

  const findings = report.crossClause.findings
    .filter((f) => f.kind !== 'gap')
    .map((f) => ({ text: f.text, citations: resolve(f.itemIds) }));
  sections.push({ key: 'inconsistencies', title: TITLES.inconsistencies, number: 0, findings });

  // TODO: remove before final product (coverage is a testing aid).
  const totals = report.ledger.totals;
  const cov = report.coverage;
  // Structure-free runs have no clause list, so their coverage is measured by chunks and pages only.
  const clauseLine =
    cov?.mode !== 'structure-free' && totals.clausesDetected > 0
      ? `Clauses detected ${totals.clausesDetected}; analysed ${totals.clausesAnalysed}; not analysed ${totals.clausesSkipped}.`
      : '';
  const lines = [
    clauseLine,
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
      reviewingFor: r?.reviewingFor ?? 'neutral',
    },
    banner: report.partial || report.unreliable ? report.notices.filter((n) => /partial|unreliable|not analysed|could not be checked|incomplete/i.test(n)) : [],
    unreviewed: unreviewedText(report.unreviewedPages ?? 0),
    toc: numbered.map((s) => ({ number: s.number, title: s.title, key: s.key })),
    sections: numbered,
    clauses,
    merge: stats,
  };
}
