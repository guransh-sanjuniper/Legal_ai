import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, DocumentRecord } from '../runner/db';
import { buildAnchorIndex, topClause, type AnchorIndex } from './anchors';
import { verifyQuotedItems } from './verify';
import { buildAnalysisChunks } from './analysisChunks';
import { JUDGE_PROMPT } from './prompts';
import { computeMetrics, createRun, executeTasks, type ExecuteContext, type TaskPlan } from './execute';
import { loadPageMap } from './runAnalysis';
import type { AnalysisMetrics } from './types';
import type { DefinitionsSheet } from '../retrieval/definitionsMerge';

export type Direction = 'favours_developer' | 'favours_society' | 'neutral';
export type Confidence = 'high' | 'medium' | 'low';

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
  party: 'developer' | 'society' | null;
  rows: JudgementRow[];
  others: JudgementRow[];
  summary: string;
  counts: {
    chunksRead: number;
    proposed: number;
    verified: number;
    dropped: Record<string, number>;
    pageCorrected: number;
    directions: Record<Direction, number>;
  };
  metrics: AnalysisMetrics;
  runId: string;
}

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

  // One row per clause: merge rows that resolved to the same clause, preferring the
  // developer-relevant item when both exist.
  const byClause = new Map<string, JudgementRow[]>();
  for (const row of rows) {
    const list = byClause.get(row.clause) ?? [];
    list.push(row);
    byClause.set(row.clause, list);
  }
  const merged = [...byClause.values()].map((list) => {
    if (list.length === 1) return list[0];
    const developer = list.find((x) => x.direction === 'favours_developer');
    const society = list.find((x) => x.direction === 'favours_society');
    const chosen = developer ?? society ?? list[0];
    return {
      ...chosen,
      why: chosen.why,
      itemIds: [...new Set(list.flatMap((x) => x.itemIds))],
    };
  });

  merged.sort((a, b) => {
    const ka = clauseSortKey(a.clause);
    const kb = clauseSortKey(b.clause);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
  });

  const directions: Record<Direction, number> = { favours_developer: 0, favours_society: 0, neutral: 0 };
  for (const row of merged) directions[row.direction]++;
  return { rows: merged, directions };
}

export function detectParty(question: string, sheet: DefinitionsSheet | null): 'developer' | 'society' | null {
  const q = question.toLowerCase();
  const asksDeveloper = /\bdeveloper(s)?\b|\bpromoter\b|\bbuilder\b/.test(q);
  const asksSociety = /\bsociety\b|\bmembers?\b/.test(q);
  if (asksDeveloper && !asksSociety) return 'developer';
  if (asksSociety && !asksDeveloper) return 'society';
  if (sheet) {
    for (const p of sheet.parties) {
      if (p.role !== 'party_to_agreement') continue;
      if (!q.includes(p.name.toLowerCase().slice(0, 12))) continue;
      return /society/i.test(p.name) ? 'society' : 'developer';
    }
  }
  return null;
}

export function filterByParty(
  rows: JudgementRow[],
  party: 'developer' | 'society' | null,
): { matching: JudgementRow[]; others: JudgementRow[] } {
  if (!party) return { matching: rows, others: [] };
  const want = party === 'developer' ? 'favours_developer' : 'favours_society';
  return {
    matching: rows.filter((r) => r.direction === want),
    others: rows.filter((r) => r.direction !== want),
  };
}

// A quote that describes a Developer burden but is labelled as favouring the Developer.
export function looksLikeDeveloperObligation(quote: string, why: string): boolean {
  const text = `${quote} ${why}`;
  if (/\b(entitled|right|permission|permitted|option|at its option|may)\b/i.test(text)) return false;
  return /\bdeveloper(s)?\b[^.]{0,80}\b(shall|must|agrees? to|undertakes? to|is (?:required|liable) to)\b[^.]{0,80}\b(pay|provide|construct|obtain|execute|furnish|complete|maintain)\b/i.test(text);
}

export interface JudgementOptions {
  db: HarnessDBHandle;
  supabase: SupabaseClient;
  accessToken: string;
  userId?: string | null;
  functionsUrl: string;
  anonKey: string;
  docId: string;
  question: string;
  sheet: DefinitionsSheet | null;
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
  return ['favours_developer', 'favours_society', 'neutral'].includes(String(o.direction));
}

export function pageInput(pages: Map<number, string>, start: number, end: number): string {
  const parts: string[] = [];
  for (let p = start; p <= end; p++) {
    const text = pages.get(p);
    if (text !== undefined) parts.push(`[[p${p}]]\n${text}`);
  }
  return parts.join('\n');
}

export async function runJudgement(opts: JudgementOptions): Promise<JudgementResult> {
  const { db, docId } = opts;
  const doc: DocumentRecord | undefined = await db.get('documents', docId);
  if (!doc?.prepFingerprint) throw new Error('document is not ready');
  const pages = await loadPageMap(db, docId);
  const index: AnchorIndex = buildAnchorIndex(pages);
  const chunks = buildAnalysisChunks(pages);

  const parties = (opts.sheet?.parties ?? []).filter((p) => p.role === 'party_to_agreement').map((p) => p.name);
  const partyLine = parties.length
    ? `PARTIES: ${parties.join('; ')}. The Developer is the developer/promoter side; the Society is the society side.`
    : 'PARTIES: the Developer (promoter) and the Society (members).';

  const ctx: ExecuteContext = {
    db,
    supabase: opts.supabase,
    accessToken: opts.accessToken,
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

  const plans: TaskPlan[] = chunks.map((chunk) => ({
    suffix: `j${chunk.index}`,
    promptVersion: 'judgement-v1',
    prompt: `${JUDGE_PROMPT}\n${partyLine}`,
    input: `QUESTION: ${opts.question}\n\n${pageInput(pages, chunk.pageStart, chunk.pageEnd)}`,
    maxTokens: opts.maxTokens ?? 1600,
    validate: isValidJudgementItem,
  }));

  const run = await executeTasks(ctx, runId, doc, plans);
  const items: JudgementItem[] = [];
  const dropped: Record<string, number> = {};
  let proposed = 0;
  let pageCorrected = 0;

  const collect = (collected: { taskId: string; items: unknown[] }[], prefix: string, offset = 0) => {
    for (const c of collected) {
      const suffix = c.taskId.slice(c.taskId.lastIndexOf(':') + 1).split('/')[0];
      if (!suffix.startsWith(prefix)) continue;
      const chunkIndex = Number(suffix.slice(prefix.length));
      addItems(chunkIndex, c.items, offset);
    }
  };

  const addItems = (chunkIndex: number, rawItems: unknown[], offset: number) => {
    const chunk = chunks.find((x) => x.index === chunkIndex);
    if (!chunk) return;
    rawItems.forEach((raw, i) => {
      proposed++;
      const item = raw as Record<string, unknown>;
      const page = Number(item.page);
      const check = verifyQuotedItems(
        'judgement',
        [{ quote: String(item.quote ?? ''), page: Number.isFinite(page) ? page : null }],
        index,
        { start: chunk.pageStart, end: chunk.pageEnd },
      );
      for (const d of check.drops) dropped[d.reason] = (dropped[d.reason] ?? 0) + 1;
      if (check.verified.length === 0) return;
      pageCorrected += check.corrected;
      const v = check.verified[0].item;
      const direction = String(item.direction) as Direction;
      const confidence = String(item.confidence) as Confidence;
      items.push({
        itemId: `J${chunkIndex}:${i}`,
        clause: v.clause,
        page: v.page,
        quote: v.quote,
        direction: ['favours_developer', 'favours_society', 'neutral'].includes(direction) ? direction : 'neutral',
        why: String(item.why ?? '').trim(),
        confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'low',
      });
    });
  }

  collect(run.collected, 'j');

  // Clauses with no finding at all get one focused retry with only those clauses' text.
  const coveredTop = new Map<number, Set<string>>();
  for (const it of items) {
    const idx = Number(it.itemId.slice(1).split(':')[0]);
    const set = coveredTop.get(idx) ?? new Set<string>();
    set.add(topClause(it.clause));
    coveredTop.set(idx, set);
  }
  const retryPlans: TaskPlan[] = [];
  for (const chunk of chunks) {
    const missing = chunk.manifest.filter((m) => !coveredTop.get(chunk.index)?.has(topClause(m)));
    if (missing.length === 0) continue;
    const segments = index.segments.filter(
      (s) => s.page >= chunk.pageStart && s.page <= chunk.pageEnd && missing.includes(topClause(s.clause)),
    );
    const text = segments.length
      ? segments.map((s) => `[[p${s.page}]]\n${s.text}`).join('\n')
      : pageInput(pages, chunk.pageStart, chunk.pageEnd);
    retryPlans.push({
      suffix: `k${chunk.index}`,
      promptVersion: 'judgement-v1',
      prompt: `${JUDGE_PROMPT}\n${partyLine}`,
      input: `QUESTION: ${opts.question}\nFocus on these clauses: ${missing.join(', ')}\n\n${text}`,
      maxTokens: 1400,
      validate: isValidJudgementItem,
    });
  }
  if (retryPlans.length) {
    opts.onLog?.(`judgement retry for ${retryPlans.length} chunks`);
    const retry = await executeTasks(ctx, runId, doc, retryPlans);
    collect(retry.collected, 'k', 1000);
  }

  // A clear Developer burden must never be presented as a Developer favour.
  const corrected = items.map((it) =>
    it.direction === 'favours_developer' && looksLikeDeveloperObligation(it.quote, it.why)
      ? { ...it, direction: 'neutral' as Direction }
      : it,
  );

  const { rows, directions } = mergeJudgements(corrected);
  const party = detectParty(opts.question, opts.sheet);
  const { matching, others } = filterByParty(rows, party);
  const summary = `${matching.length} clause${matching.length === 1 ? '' : 's'} ${
    party ? `favouring the ${party}` : 'grouped'
  }: ${directions.favours_developer} pro-Developer, ${directions.favours_society} pro-Society, ${directions.neutral} neutral.`;

  const metrics = await computeMetrics(db, await db.getAllFromIndex('tasks', 'byRun', runId));
  await opts.supabase.from('runs').update({ status: 'complete', updated_at: new Date().toISOString() }).eq('id', runId);

  return {
    question: opts.question,
    party,
    rows: matching,
    others,
    summary,
    counts: { chunksRead: chunks.length, proposed, verified: items.length, dropped, pageCorrected, directions },
    metrics,
    runId,
  };
}

export { topClause };
