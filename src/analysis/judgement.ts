import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, DocumentRecord } from '../runner/db';
import { buildAnchorIndex, topClause, type AnchorIndex } from './anchors';
import { verifyQuotedItems } from './verify';
import { buildAnalysisChunks } from './analysisChunks';
import { JUDGE_PROMPT, checklistFor } from './prompts';
import { computeMetrics, createRun, executeTasks, type ExecuteContext, type TaskPlan } from './execute';
import { loadPageMap } from './runAnalysis';
import type { AnalysisMetrics } from './types';
import type { DefinitionsSheet } from '../retrieval/definitionsMerge';
import type { DocType } from './docType';

// A = first party to the agreement in the definitions sheet, B = second. Names come from the sheet only.
export type Side = 'a' | 'b';
export type Direction = 'favours_a' | 'favours_b' | 'neutral';
export type Confidence = 'high' | 'medium' | 'low';
const DIRECTIONS: Direction[] = ['favours_a', 'favours_b', 'neutral'];

export interface Parties {
  a: string | null;
  b: string | null;
}

export interface JudgementItem {
  itemId: string;
  clause: string;
  page: number;
  quote: string;
  direction: Direction;
  why: string;
  confidence: Confidence;
}

export interface JudgementRow {
  clause: string;
  page: number;
  why: string;
  quote: string;
  direction: Direction;
  confidence: Confidence;
  itemIds: string[];
}

export interface JudgementResult {
  question: string;
  side: Side | null;
  parties: Parties;
  rows: JudgementRow[];
  others: JudgementRow[];
  summary: string;
  counts: {
    chunksRead: number;
    subGroups: number;
    proposed: number;
    verified: number;
    dropped: Record<string, number>;
    pageCorrected: number;
    directions: Record<Direction, number>;
  };
  metrics: AnalysisMetrics;
  runId: string;
}

// Characters of sub-item text per task. Sub-items of one clause are packed up to this size.
export const SUB_GROUP_CHARS = 2400;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function canonicalClause(label: string): string {
  // Keep a sub-item closing bracket; only a trailing dot is punctuation.
  return label.trim().toLowerCase().replace(/\s+/g, '').replace(/\.+$/, '');
}

function clauseSortKey(clause: string): [number, number, string] {
  const m = /^(\d+)(?:\(([a-z]+|\d+)\))?/.exec(canonicalClause(clause));
  if (!m) return [9999, 9999, clause];
  const sub = m[2] ? (/\d+/.test(m[2]) ? Number(m[2]) : m[2].charCodeAt(0) - 96) : 0;
  return [Number(m[1]), sub, clause];
}

// Two quotes are the same finding when they are equal, one contains the other, or their
// token overlap is very high.
export function quoteOverlap(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  if (Math.min(ta.size, tb.size) < 8) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size) >= 0.9;
}

export function mergeJudgements(items: JudgementItem[]): { rows: JudgementRow[]; directions: Record<Direction, number> } {
  const groups: JudgementItem[][] = [];
  for (const item of items) {
    const group = groups.find((g) => quoteOverlap(g[0].quote, item.quote));
    if (group) group.push(item);
    else groups.push([item]);
  }

  const rows: JudgementRow[] = groups.map((g) => {
    const best = [...g].sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 };
      return rank[a.confidence] - rank[b.confidence];
    })[0];
    const clause = canonicalClause(best.clause) || best.clause;
    return {
      clause,
      page: best.page,
      why: best.why,
      quote: best.quote,
      direction: best.direction,
      confidence: best.confidence,
      itemIds: g.map((x) => x.itemId),
    };
  });

  // One row per clause: rows for the same clause merge, keeping a benefit row for either side over neutral.
  const byClause = new Map<string, JudgementRow[]>();
  for (const row of rows) {
    const list = byClause.get(row.clause) ?? [];
    list.push(row);
    byClause.set(row.clause, list);
  }
  const merged = [...byClause.values()].map((list) => {
    if (list.length === 1) return list[0];
    const benefit = list.find((x) => x.direction !== 'neutral');
    const chosen = benefit ?? list[0];
    return { ...chosen, itemIds: [...new Set(list.flatMap((x) => x.itemIds))] };
  });

  merged.sort((a, b) => {
    const ka = clauseSortKey(a.clause);
    const kb = clauseSortKey(b.clause);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
  });

  const directions = { favours_a: 0, favours_b: 0, neutral: 0 } as Record<Direction, number>;
  for (const row of merged) directions[row.direction]++;
  return { rows: merged, directions };
}

// The two parties to the agreement, in definitions-sheet order.
export function partiesOf(sheet: DefinitionsSheet | null): Parties {
  const names = (sheet?.parties ?? []).filter((p) => p.role === 'party_to_agreement').map((p) => p.name);
  return { a: names[0] ?? null, b: names[1] ?? null };
}

export function partyLineFor(parties: Parties): string {
  if (parties.a && parties.b) {
    return `PARTIES: [A] ${parties.a}; [B] ${parties.b}. favours_a = a benefit to [A]; favours_b = a benefit to [B].`;
  }
  return 'PARTIES: the two parties to the agreement, as named in the text. favours_a = a benefit to the first party; favours_b = a benefit to the second party.';
}

// The side the question asks about, found by naming a party in the question.
export function detectSide(question: string, parties: Parties): Side | null {
  const q = question.toLowerCase();
  const hitA = !!parties.a && q.includes(parties.a.toLowerCase().slice(0, 12));
  const hitB = !!parties.b && q.includes(parties.b.toLowerCase().slice(0, 12));
  if (hitA && !hitB) return 'a';
  if (hitB && !hitA) return 'b';
  return null;
}

export function filterBySide(
  rows: JudgementRow[],
  side: Side | null,
): { matching: JudgementRow[]; others: JudgementRow[] } {
  if (!side) return { matching: rows, others: [] };
  const want: Direction = side === 'a' ? 'favours_a' : 'favours_b';
  return {
    matching: rows.filter((r) => r.direction === want),
    others: rows.filter((r) => r.direction !== want),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A quote that describes a burden on the party it is labelled as favouring. The party is
// named from the definitions sheet; the wording is general obligation language.
export function looksLikeBurdenOn(quote: string, why: string, partyName: string | null): boolean {
  if (!partyName) return false;
  const text = `${quote} ${why}`;
  if (/\b(entitled|right|permission|permitted|option|at its option|may)\b/i.test(text)) return false;
  const words = partyName.trim().split(/\s+/).slice(0, 2).map(escapeRe).join('\\s+');
  const who = `${words}s?`;
  return new RegExp(
    `\\b${who}\\b[^.]{0,80}\\b(shall|must|agrees? to|undertakes? to|is (?:required|liable) to)\\b[^.]{0,80}\\b(pay|provide|construct|obtain|execute|furnish|complete|maintain)\\b`,
    'i',
  ).test(text);
}

export interface JudgementOptions {
  db: HarnessDBHandle;
  supabase: SupabaseClient;
  accessToken: string;
  refreshAccessToken?: (force?: boolean) => Promise<string | null>;
  userId?: string | null;
  functionsUrl: string;
  anonKey: string;
  docId: string;
  question: string;
  sheet: DefinitionsSheet | null;
  docType?: DocType | null;
  model: string;
  fallbackModel: string | null;
  maxTokens?: number;
  onLog?: (line: string) => void;
}

export function isValidJudgementItem(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.quote !== 'string' || typeof o.why !== 'string') return false;
  if (typeof o.page !== 'number' && typeof o.page !== 'string') return false;
  return DIRECTIONS.includes(o.direction as Direction);
}

export interface SubGroup {
  suffix: string;
  clause: string;
  pageStart: number;
  pageEnd: number;
  text: string;
}

// Sub-items (lettered or roman, in any clause) are packed per parent clause into small groups,
// so each group is checked on its own. No clause numbers are referenced here.
export function subItemGroups(index: AnchorIndex, maxChars = SUB_GROUP_CHARS): SubGroup[] {
  const groups: SubGroup[] = [];
  let cur: { top: string; segs: typeof index.segments; chars: number } | null = null;
  const close = () => {
    if (!cur || cur.segs.length === 0) return;
    const pages = cur.segs.map((s) => s.page);
    const text = cur.segs.map((s) => `[[p${s.page}]]\n${s.text}`).join('\n');
    groups.push({
      suffix: `s${groups.length}`,
      clause: cur.top,
      pageStart: Math.min(...pages),
      pageEnd: Math.max(...pages),
      text,
    });
    cur = null;
  };
  for (const seg of index.segments) {
    if (seg.top === null) {
      close();
      continue;
    }
    // Top-level text of the clause is context, not a sub-item, so it never opens a group.
    if (seg.clause === seg.top) continue;
    if (cur && (cur.top !== seg.top || cur.chars + seg.text.length > maxChars)) close();
    if (!cur) cur = { top: seg.top, segs: [], chars: 0 };
    cur.segs.push(seg);
    cur.chars += seg.text.length;
  }
  close();
  return groups;
}

export async function runJudgement(opts: JudgementOptions): Promise<JudgementResult> {
  const { db, docId } = opts;
  const doc: DocumentRecord | undefined = await db.get('documents', docId);
  if (!doc?.prepFingerprint) throw new Error('document is not ready');
  const pages = await loadPageMap(db, docId);
  const index: AnchorIndex = buildAnchorIndex(pages);
  const chunks = buildAnalysisChunks(pages);
  const parties = partiesOf(opts.sheet);
  const side = detectSide(opts.question, parties);
  const prompt = `${JUDGE_PROMPT}\n${partyLineFor(parties)}\n${checklistFor(opts.docType ?? null)}`;

  const ctx: ExecuteContext = {
    db,
    supabase: opts.supabase,
    accessToken: opts.accessToken,
    refreshAccessToken: opts.refreshAccessToken,
    userId: opts.userId,
    functionsUrl: opts.functionsUrl,
    anonKey: opts.anonKey,
    model: opts.model,
    fallbackModel: opts.fallbackModel,
    reasoning: null,
    timeoutMs: 110_000,
    onLog: opts.onLog,
  };
  const runId = await createRun(ctx, doc);

  // Every task carries the page range it may quote from, keyed by its suffix.
  const ranges = new Map<string, { start: number; end: number }>();
  const subs = subItemGroups(index);
  const plans: TaskPlan[] = [];
  for (const chunk of chunks) {
    ranges.set(`j${chunk.index}`, { start: chunk.pageStart, end: chunk.pageEnd });
    plans.push({
      suffix: `j${chunk.index}`,
      promptVersion: 'judgement-v3',
      prompt,
      input: `QUESTION: ${opts.question}\n\n${chunk.pageMarkedText}`,
      maxTokens: opts.maxTokens ?? 1600,
      validate: isValidJudgementItem,
    });
  }
  for (const g of subs) {
    ranges.set(g.suffix, { start: g.pageStart, end: g.pageEnd });
    plans.push({
      suffix: g.suffix,
      promptVersion: 'judgement-sub-v2',
      prompt,
      input: `QUESTION: ${opts.question}\nThe excerpt is one group of sub-items of clause ${g.clause}. Judge each sub-item on its own.\n\n${g.text}`,
      maxTokens: 1000,
      validate: isValidJudgementItem,
    });
  }

  const items: JudgementItem[] = [];
  const dropped: Record<string, number> = {};
  let proposed = 0;
  let pageCorrected = 0;

  // Verifies every proposed item against the page range of the task that produced it.
  const ingest = (collected: { taskId: string; items: unknown[] }[]) => {
    for (const c of collected) {
      const suffix = c.taskId.slice(c.taskId.lastIndexOf(':') + 1).split('/')[0];
      const range = ranges.get(suffix);
      if (!range) continue;
      c.items.forEach((raw, i) => {
        proposed++;
        const item = raw as Record<string, unknown>;
        const page = Number(item.page);
        const check = verifyQuotedItems(
          'judgement',
          [{ quote: String(item.quote ?? ''), page: Number.isFinite(page) ? page : null }],
          index,
          range,
        );
        for (const d of check.drops) dropped[d.reason] = (dropped[d.reason] ?? 0) + 1;
        if (check.verified.length === 0) return;
        pageCorrected += check.corrected;
        const v = check.verified[0].item;
        const direction = String(item.direction) as Direction;
        const confidence = String(item.confidence) as Confidence;
        items.push({
          itemId: `${suffix}:${i}`,
          clause: v.clause,
          page: v.page,
          quote: v.quote,
          direction: DIRECTIONS.includes(direction) ? direction : 'neutral',
          why: String(item.why ?? '').trim(),
          confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'low',
        });
      });
    }
  };

  const run = await executeTasks(ctx, runId, doc, plans);
  ingest(run.collected);

  // Clauses with no finding in their chunk get one focused retry with only their text.
  const retryPlans: TaskPlan[] = [];
  for (const chunk of chunks) {
    const covered = new Set(
      items.filter((it) => it.page >= chunk.pageStart && it.page <= chunk.pageEnd).map((it) => topClause(it.clause)),
    );
    const missing = chunk.manifest.filter((m) => !covered.has(topClause(m)));
    if (missing.length === 0) continue;
    const text = index.segments
      .filter((s) => s.page >= chunk.pageStart && s.page <= chunk.pageEnd && missing.includes(topClause(s.clause)))
      .map((s) => `[[p${s.page}]]\n${s.text}`)
      .join('\n');
    const suffix = `k${chunk.index}`;
    ranges.set(suffix, { start: chunk.pageStart, end: chunk.pageEnd });
    retryPlans.push({
      suffix,
      promptVersion: 'judgement-v3',
      prompt,
      input: `QUESTION: ${opts.question}\nFocus on these clauses: ${missing.join(', ')}\n\n${text || chunk.pageMarkedText}`,
      maxTokens: 1400,
      validate: isValidJudgementItem,
    });
  }
  if (retryPlans.length) {
    opts.onLog?.(`judgement retry for ${retryPlans.length} chunks`);
    const retry = await executeTasks(ctx, runId, doc, retryPlans);
    ingest(retry.collected);
  }

  // A burden on a party must never be presented as a benefit to that party.
  const nameOf = (d: Direction) => (d === 'favours_a' ? parties.a : d === 'favours_b' ? parties.b : null);
  const corrected = items.map((it) =>
    looksLikeBurdenOn(it.quote, it.why, nameOf(it.direction)) ? { ...it, direction: 'neutral' as Direction } : it,
  );

  const { rows, directions } = mergeJudgements(corrected);
  const { matching, others } = filterBySide(rows, side);
  const who = side ? (side === 'a' ? parties.a : parties.b) : null;
  const summary = `${matching.length} clause${matching.length === 1 ? '' : 's'} ${
    who ? `favouring ${who}` : 'grouped'
  }: ${directions.favours_a} favour ${parties.a ?? '[A]'}, ${directions.favours_b} favour ${parties.b ?? '[B]'}, ${directions.neutral} neutral.`;

  const metrics = await computeMetrics(db, await db.getAllFromIndex('tasks', 'byRun', runId));
  await opts.supabase.from('runs').update({ status: 'complete', updated_at: new Date().toISOString() }).eq('id', runId);

  return {
    question: opts.question,
    side,
    parties,
    rows: matching,
    others,
    summary,
    counts: {
      chunksRead: chunks.length,
      subGroups: subs.length,
      proposed,
      verified: items.length,
      dropped,
      pageCorrected,
      directions,
    },
    metrics,
    runId,
  };
}
