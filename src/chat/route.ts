import type { Citation, ReportModel, ReportSection, SectionKey } from '../analysis/reportModel';

// Chooses how a document question is answered. Pure: no I/O, no model call.
//   scanWhole                  -> whole   (the user asked for a full scan; saved rows are not used)
//   saved rows match           -> saved   (rows from the stored report, cited to their source)
//   anything else             -> retrieval (hybrid search, then the prompt pass and synthesis)

export const SAVED_ROW_LIMIT = 8;

export interface SavedRow {
  label: string;
  text: string;
  citation: Citation | null;
}

export type Route =
  | { mode: 'saved'; rows: SavedRow[]; total: number }
  | { mode: 'retrieval' }
  | { mode: 'whole' };

type Sec<K extends SectionKey> = Extract<ReportSection, { key: K }>;

function sectionOf<K extends SectionKey>(model: ReportModel, key: K): Sec<K> | undefined {
  return model.sections.find((s): s is Sec<K> => s.key === key);
}

const CLAUSE = /\bclause\s+(\d+(?:\.\d+)*)/i;
const MISSING = /\b(missing|absent|lack\w*|not (?:included|covered|mentioned|stated)|no (?:clause|provision|protection))\b/i;
const MONEY = /\b(amounts?|deposits?|rent|fees?|pay(?:ment|ments|able|s)?|paid|price|cost|charges?|premium|money|advance|security|how much|sum)\b/i;
const DATE = /\b(dates?|deadlines?|due|when|expir\w*|notice|periods?|term|commenc\w*|renew\w*|start\w*|end)\b/i;
const OBLIGATION = /\b(obligations?|duty|duties|responsib\w*|must|owes?|owed|owing|liable|who (?:must|has to|should|is required))\b/i;
const RISK = /\b(risks?|liabilit\w*|penalt\w*|concerns?|exposure|unfair|one-sided|dangers?)\b/i;
const OVERVIEW = /\b(what is (?:this|the) (?:document|agreement|contract|lease|deed) about|overview|summary|summari[sz]e|nature|purpose|parties|project details?|about (?:this|the) (?:document|agreement|contract))\b/i;

import { contentTokens, significantTerms } from '../analysis/questionTerms';

export { contentTokens, significantTerms };

interface Candidate extends SavedRow {
  // Text the question is matched against. Not shown.
  match: string;
}

function candidatesFor(model: ReportModel, kind: 'money' | 'date' | 'obligation' | 'risk' | 'missing' | 'overview'): Candidate[] {
  if (kind === 'overview') {
    return (sectionOf(model, 'overview')?.points ?? [])
      .filter((p) => p.sentences.length > 0)
      .map((p) => ({
        label: `Overview: ${p.title}`,
        text: p.sentences.map((s) => s.text).join(' '),
        match: `${p.title} ${p.sentences.map((s) => s.text).join(' ')}`,
        citation: p.sentences.flatMap((s) => s.citations)[0] ?? null,
      }));
  }
  if (kind === 'money') {
    return (sectionOf(model, 'datesAmounts')?.amounts ?? []).map((a) => ({
      label: `Amount: ${a.purpose || 'purpose not stated'}`,
      text: `${a.amount}; payer to payee: ${a.payerToPayee}; due: ${a.due}; clause ${a.clause}.`,
      match: `${a.purpose} ${a.payerToPayee} ${a.amount}`,
      citation: a.citation,
    }));
  }
  if (kind === 'date') {
    return (sectionOf(model, 'datesAmounts')?.dates ?? []).map((d) => ({
      label: `Date: ${d.purpose || 'purpose not stated'}`,
      text: `${d.date} (${d.timing}); clause ${d.clause}.`,
      match: `${d.purpose} ${d.date} ${d.clause}`,
      citation: d.citation,
    }));
  }
  if (kind === 'obligation') {
    return (sectionOf(model, 'obligations')?.groups ?? []).flatMap((g) =>
      g.rows.map((r) => ({
        label: `${g.party} · clause ${r.clause}`,
        text: r.text,
        match: `${g.party} ${r.text}`,
        citation: r.citation,
      })),
    );
  }
  if (kind === 'risk') {
    return (sectionOf(model, 'risks')?.risks ?? []).map((r) => ({
      label: `Risk (${r.priority} priority), clause ${r.clause}`,
      text: r.issue,
      match: `${r.issue} ${r.affects}`,
      citation: r.citation,
    }));
  }
  return (sectionOf(model, 'risks')?.missing ?? []).map((r) => ({
    label: `Missing protection, clause ${r.clause}`,
    text: r.issue,
    match: r.issue,
    citation: r.citation,
  }));
}

// Party words name who the question is about, not the subject of the row: "what are the parties'
// obligations" must match the obligation rows. Local to the router; the shared term list is unchanged.
const ROUTE_PARTY_TERMS = new Set(['partie', 'party']);

// A row answers the question only when every specific word of the question appears in it. Sharing
// one word is not enough: "late rent" must not return the monthly rent row.
function pick(candidates: Candidate[], question: string): { rows: Candidate[]; total: number } | null {
  if (candidates.length === 0) return null;
  const specific = significantTerms(question).filter((t) => !ROUTE_PARTY_TERMS.has(t));
  const matched = specific.length === 0
    ? candidates
    : candidates.filter((c) => {
        const row = new Set(contentTokens(c.match));
        return specific.every((t) => row.has(t));
      });
  if (matched.length === 0) return null;
  return { rows: matched.slice(0, SAVED_ROW_LIMIT), total: matched.length };
}

const strip = (c: Candidate): SavedRow => ({ label: c.label, text: c.text, citation: c.citation });

// Rows from the stored report that answer the question, or null when nothing matches. The order
// matters: a clause number, then missing, money, dates, obligations, risks.
export function savedRowsFor(question: string, model: ReportModel): { rows: SavedRow[]; total: number } | null {
  const clauseNo = CLAUSE.exec(question)?.[1];
  if (clauseNo) {
    const clause = model.clauses.find((c) => c.clauseNo.replace(/\s+/g, '').toLowerCase() === clauseNo);
    if (!clause) return null;
    const summary = clause.rows.find((r) => r.label === 'Summary')?.text;
    if (!summary) return null;
    const citation = clause.rows.flatMap((r) => r.citations)[0] ?? null;
    return { rows: [{ label: `Clause ${clauseNo}`, text: summary, citation }], total: 1 };
  }

  if (MISSING.test(question)) {
    // The missing list is a list: a question about missing terms returns all of it, not a match.
    const missing = candidatesFor(model, 'missing');
    if (missing.length > 0) return { rows: missing.slice(0, SAVED_ROW_LIMIT).map(strip), total: missing.length };
  }
  const intents: [RegExp, 'money' | 'date' | 'obligation' | 'risk'][] = [
    [MONEY, 'money'],
    [DATE, 'date'],
    [OBLIGATION, 'obligation'],
    [RISK, 'risk'],
  ];
  for (const [re, kind] of intents) {
    if (!re.test(question)) continue;
    const hit = pick(candidatesFor(model, kind), question);
    if (hit) return { rows: hit.rows.map(strip), total: hit.total };
  }
  // Overview comes last: a descriptive question with no action word. "What is this about" returns
  // every point, not one match.
  if (OVERVIEW.test(question)) {
    const points = candidatesFor(model, 'overview');
    if (points.length > 0) return { rows: points.slice(0, SAVED_ROW_LIMIT).map(strip), total: points.length };
  }
  return null;
}

export function routeQuestion(question: string, model: ReportModel | null, scanWhole: boolean): Route {
  if (scanWhole) return { mode: 'whole' };
  if (model) {
    const hit = savedRowsFor(question, model);
    if (hit) return { mode: 'saved', rows: hit.rows, total: hit.total };
  }
  return { mode: 'retrieval' };
}

// Only the fields a message keeps. Chunk text is never stored with a citation.
export function citationFields(c: Citation): Citation {
  return { page: c.page, clause: c.clause, quote: c.quote };
}

export function uniqueCitations(list: (Citation | null | undefined)[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of list) {
    if (!c) continue;
    const key = `${c.page}|${c.clause}|${c.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citationFields(c));
  }
  return out;
}
