import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, DocumentRecord } from '../runner/db';
import { getDefinitions, definitionsContext } from '../retrieval/definitions';
import { LAW_STANDIN_VERSION } from '../retrieval/config';
import { buildAnchorIndex, topClause, type AnchorIndex } from './anchors';
import { buildAnalysisChunks, type AnalysisChunk } from './analysisChunks';
import { verifyQuotedItems } from './verify';
import { extractAmounts, uncapturedAmounts } from './amounts';
import { groupForRollup, keepCitedSentences, overviewTargetSentenceCount } from './rollup';
import { buildLedger, type LedgerChunkInput } from './ledger';
import { findContradictions, missingTopicCandidates, paymentTotals } from './crossClause';
import { CLAUSE_PROMPT, SECTION_PROMPT, OVERVIEW_PROMPT } from './prompts';
import { computeMetrics, createRun, executeTasks, type ExecuteContext, type TaskPlan } from './execute';
import { INITIAL_MAX_TOKENS, ANALYSIS_TIMEOUT_MS } from './config';
import type {
  AnalysisReport,
  CrossClauseResult,
  DropRecord,
  RollupSentence,
  SectionSummary,
  VerifiedClause,
  VerifiedDate,
  VerifiedObligation,
  VerifiedPayment,
  VerifiedRisk,
  LawPassageRef,
} from './types';

export interface LawHitLite {
  id: string;
  title: string;
  text: string;
  fused: number;
  lawVersion: string;
}

export interface SearchHitLite {
  pageStart: number;
  pageEnd: number;
  fused: number;
}

export interface AnalysisOptions {
  db: HarnessDBHandle;
  supabase: SupabaseClient;
  accessToken: string;
  userId?: string | null;
  functionsUrl: string;
  anonKey: string;
  docId: string;
  model: string;
  fallbackModel: string | null;
  reasoning?: { effort: 'minimal' } | null;
  maxTokens?: number | null;
  lawSearch: (text: string, k: number) => Promise<LawHitLite[]>;
  docSearch: (query: string, k: number) => Promise<SearchHitLite[]>;
  onProgress?: (msg: string) => void;
  onLog?: (msg: string) => void;
}

export function isValidClauseItem(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.clause_no !== 'string' || typeof o.summary !== 'string' || typeof o.type !== 'string') return false;
  for (const key of ['obligations', 'dates', 'payments', 'risks']) {
    if (o[key] !== undefined && !Array.isArray(o[key])) return false;
  }
  return true;
}

const arrOf = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface RawObligation {
  party?: unknown;
  text?: unknown;
  page?: unknown;
  quote?: unknown;
}
interface RawDate {
  text?: unknown;
  timing_type?: unknown;
  page?: unknown;
  quote?: unknown;
}
interface RawPayment {
  amount?: unknown;
  payer?: unknown;
  payee?: unknown;
  due?: unknown;
  page?: unknown;
  quote?: unknown;
}
interface RawRisk {
  text?: unknown;
  severity?: unknown;
  page?: unknown;
  quote?: unknown;
}

export async function loadPageMap(db: HarnessDBHandle, docId: string): Promise<Map<number, string>> {
  const pages = await db.getAll('pages', IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]));
  return new Map(pages.map((p) => [p.pageNo, p.text]));
}

export function pageInput(pages: Map<number, string>, start: number, end: number): string {
  const parts: string[] = [];
  for (let p = start; p <= end; p++) {
    const text = pages.get(p);
    if (text !== undefined) parts.push(`[[p${p}]]\n${text}`);
  }
  return parts.join('\n');
}

function clauseInput(chunk: AnalysisChunk, pages: Map<number, string>, defsContext: string, clauses: string[]): string {
  return [
    defsContext,
    `CLAUSE NUMBERS IN THIS EXCERPT: ${clauses.join(', ')}`,
    pageInput(pages, chunk.pageStart, chunk.pageEnd),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function subsetInput(
  chunk: AnalysisChunk,
  missing: string[],
  index: AnchorIndex,
  defsContext: string,
): string {
  const segments = index.segments.filter(
    (s) => s.page >= chunk.pageStart && s.page <= chunk.pageEnd && missing.includes(topClause(s.clause)),
  );
  if (segments.length === 0) return '';
  const byPage = new Map<number, string[]>();
  for (const s of segments) {
    const list = byPage.get(s.page) ?? [];
    list.push(s.text);
    byPage.set(s.page, list);
  }
  const text = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([p, parts]) => `[[p${p}]]\n${parts.join('\n')}`)
    .join('\n');
  return `${defsContext}\n\nCLAUSE NUMBERS IN THIS EXCERPT: ${missing.join(', ')}\n\n${text}`;
}

export async function runAnalysis(opts: AnalysisOptions): Promise<AnalysisReport> {
  const { db, supabase, docId } = opts;
  const log = opts.onLog ?? (() => {});
  const progress = opts.onProgress ?? (() => {});

  const doc: DocumentRecord | undefined = await db.get('documents', docId);
  if (!doc || doc.status !== 'ready' || !doc.prepFingerprint) throw new Error('document is not ready');
  const pages = await loadPageMap(db, docId);
  const index = buildAnchorIndex(pages);
  const chunks = buildAnalysisChunks(pages);
  const sheet = await getDefinitions(db, docId);
  if (!sheet) throw new Error('build the definitions sheet on the Search page first');
  const defsContext = definitionsContext(sheet);

  const state = await db.get('analysis_state', docId);
  const budget = opts.maxTokens ?? state?.maxTokens ?? INITIAL_MAX_TOKENS;
  progress(`analysis budget: ${budget} max_tokens · ${chunks.length} analysis chunks`);

  const ctx: ExecuteContext = {
    db,
    supabase,
    accessToken: opts.accessToken,
    userId: opts.userId,
    functionsUrl: opts.functionsUrl,
    anonKey: opts.anonKey,
    model: opts.model,
    fallbackModel: opts.fallbackModel,
    reasoning: opts.reasoning ?? null,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    onLog: log,
  };

  const runId = await createRun(ctx, doc);

  // 1. Clause analysis, one task per analysis chunk, every clause number requested.
  const plans: TaskPlan[] = chunks.map((chunk) => ({
    suffix: `a${chunk.index}`,
    promptVersion: 'clause-analysis-v2',
    prompt: CLAUSE_PROMPT,
    input: clauseInput(chunk, pages, defsContext, chunk.manifest),
    maxTokens: budget,
    validate: isValidClauseItem,
  }));
  progress(`analysing ${plans.length} chunks`);
  const first = await executeTasks(ctx, runId, doc, plans);

  const rawByChunk = new Map<number, unknown[]>();
  const collect = (collected: { taskId: string; items: unknown[] }[], prefix: string) => {
    for (const c of collected) {
      const suffix = c.taskId.slice(c.taskId.lastIndexOf(':') + 1).split('/')[0];
      if (!suffix.startsWith(prefix)) continue;
      const idx = Number(suffix.slice(prefix.length));
      if (!Number.isFinite(idx)) continue;
      const list = rawByChunk.get(idx) ?? [];
      list.push(...c.items);
      rawByChunk.set(idx, list);
    }
  };
  collect(first.collected, 'a');

  // 2. Clauses with no entry are retried once with a smaller, clause-only input.
  const missingByChunk = new Map<number, string[]>();
  for (const chunk of chunks) {
    const received = new Set(
      (rawByChunk.get(chunk.index) ?? [])
        .filter(isValidClauseItem)
        .map((x) => topClause(String((x as Record<string, unknown>).clause_no ?? ''))),
    );
    const missing = chunk.manifest.filter((c) => !received.has(topClause(c)));
    if (missing.length) missingByChunk.set(chunk.index, missing);
  }

  if (missingByChunk.size > 0) {
    const retryPlans: TaskPlan[] = [];
    for (const [indexNo, missing] of missingByChunk) {
      const chunk = chunks.find((c) => c.index === indexNo)!;
      const input = subsetInput(chunk, missing, index, defsContext) || clauseInput(chunk, pages, defsContext, missing);
      retryPlans.push({
        suffix: `r${indexNo}`,
        promptVersion: 'clause-analysis-v2',
        prompt: CLAUSE_PROMPT,
        input,
        maxTokens: Math.min(budget, 1200),
        validate: isValidClauseItem,
      });
    }
    progress(`retrying ${retryPlans.length} chunks with skipped clauses`);
    const retry = await executeTasks(ctx, runId, doc, retryPlans);
    collect(retry.collected, 'r');
  }

  // 3. Verification (code) + law lookup for risks. Page and clause come from the resolver.
  const lawCache = new Map<string, LawPassageRef[]>();
  const verifiedClauses: VerifiedClause[] = [];
  const drops: DropRecord[] = [];
  let lawCalls = 0;
  let pageCorrected = 0;

  for (const chunk of chunks) {
    const rawItems = rawByChunk.get(chunk.index) ?? [];
    const seenClauses = new Set<string>();
    let emitted = 0;

    for (const raw of rawItems) {
      if (!isValidClauseItem(raw)) continue;
      const item = raw as Record<string, unknown>;
      const rawClause = str(item.clause_no).trim() || `#${++emitted}`;
      const rawTop = topClause(rawClause);
      if (chunk.manifest.length > 0 && !chunk.manifest.some((m) => topClause(m) === rawTop)) continue;
      if (seenClauses.has(rawTop)) continue;
      seenClauses.add(rawTop);

      const range = { start: chunk.pageStart, end: chunk.pageEnd };
      const obligations = verifyQuotedItems<RawObligation>('obligation', arrOf<RawObligation>(item.obligations), index, range);
      const dates = verifyQuotedItems<RawDate>('date', arrOf<RawDate>(item.dates), index, range);
      const payments = verifyQuotedItems<RawPayment>('payment', arrOf<RawPayment>(item.payments), index, range);
      const risks = verifyQuotedItems<RawRisk>('risk', arrOf<RawRisk>(item.risks), index, range);
      pageCorrected += obligations.corrected + dates.corrected + payments.corrected + risks.corrected;
      for (const r of [...obligations.drops, ...dates.drops, ...payments.drops, ...risks.drops]) {
        drops.push({ clauseNo: rawClause, kind: r.kind, reason: r.reason, page: r.page, quote: r.quote });
      }

      const allVerified = [...obligations.verified, ...dates.verified, ...payments.verified, ...risks.verified];
      const codeClause = allVerified.length ? topClause(allVerified[0].item.clause) : rawTop;
      const base = `C${chunk.index}:${codeClause || rawClause}`;

      const vObligations: VerifiedObligation[] = obligations.verified.map((v, i) => ({
        itemId: `${base}:ob${i}`,
        clause: v.item.clause,
        party: str(v.item.party),
        text: str(v.item.text),
        page: v.item.page,
        quote: v.item.quote,
        verified: true,
      }));
      const vDates: VerifiedDate[] = dates.verified.map((v, i) => ({
        itemId: `${base}:d${i}`,
        clause: v.item.clause,
        text: str(v.item.text),
        timing_type: ['fixed', 'event_relative', 'none'].includes(str(v.item.timing_type))
          ? (v.item.timing_type as VerifiedDate['timing_type'])
          : 'none',
        page: v.item.page,
        quote: v.item.quote,
        verified: true,
      }));
      const vPayments: VerifiedPayment[] = payments.verified.map((v, i) => ({
        itemId: `${base}:p${i}`,
        clause: v.item.clause,
        amount: str(v.item.amount),
        payer: str(v.item.payer),
        payee: str(v.item.payee),
        due: str(v.item.due),
        page: v.item.page,
        quote: v.item.quote,
        verified: true,
      }));

      const vRisks: VerifiedRisk[] = [];
      for (let i = 0; i < risks.verified.length; i++) {
        const v = risks.verified[i];
        const riskText = str(v.item.text);
        let passages: LawPassageRef[] = [];
        if (lawCalls < 45) {
          const key = `${codeClause}|${riskText}`;
          if (lawCache.has(key)) passages = lawCache.get(key)!;
          else {
            try {
              const hits = await opts.lawSearch(`${str(item.summary)} ${riskText}`, 3);
              passages = hits.map((h) => ({ id: h.id, title: h.title, text: h.text, fused: h.fused, lawVersion: h.lawVersion }));
            } catch (e) {
              log(`law search failed for clause ${codeClause}: ${String(e)}`);
            }
            lawCalls++;
            lawCache.set(key, passages);
          }
        }
        vRisks.push({
          itemId: `${base}:r${i}`,
          clause: v.item.clause,
          text: riskText,
          severity: ['high', 'medium', 'low'].includes(str(v.item.severity))
            ? (v.item.severity as VerifiedRisk['severity'])
            : 'medium',
          page: v.item.page,
          quote: v.item.quote,
          verified: true,
          lawPassages: passages,
          applicability: 'unverified',
        });
      }

      verifiedClauses.push({
        itemId: base,
        clauseNo: codeClause || rawClause,
        type: str(item.type) || 'other',
        summary: str(item.summary),
        chunkId: `analysis:${chunk.index}`,
        chunkIndex: chunk.index,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        obligations: vObligations,
        dates: vDates,
        payments: vPayments,
        risks: vRisks,
        verifiedItems: vObligations.length + vDates.length + vPayments.length + vRisks.length,
      });
    }
  }
  progress(`verified ${verifiedClauses.length} clauses, dropped ${drops.length} unverified items, corrected ${pageCorrected} pages`);

  // 4. Roll-up as dependent tasks.
  const rollupItems = verifiedClauses.map((c) => ({
    id: c.itemId,
    clause: c.clauseNo,
    type: c.type,
    summary: c.summary,
    obligations: c.obligations.map((o) => `${o.party}: ${o.text}`),
    dates: c.dates.map((d) => `${d.text} (${d.timing_type})`),
    payments: c.payments.map((p) => `${p.payer} pays ${p.payee} ${p.amount} ${p.due}`),
    risks: c.risks.map((r) => `${r.severity}: ${r.text}`),
  }));

  const groups = groupForRollup(rollupItems);
  const sectionPlans: TaskPlan[] = groups.map((group, i) => ({
    suffix: `s${i}`,
    promptVersion: 'section-summary-v1',
    prompt: SECTION_PROMPT,
    input: `${defsContext}\n\nItems:\n${JSON.stringify(group)}`,
    maxTokens: Math.max(800, Math.min(1800, group.length * 30)),
    validate: (x) => typeof x === 'object' && x !== null && typeof (x as { text?: unknown }).text === 'string',
  }));

  const sections: SectionSummary[] = groups.map((group, i) => ({ section: i + 1, itemIds: group.map((g) => g.id), sentences: [], dropped: 0 }));
  if (sectionPlans.length > 0) {
    progress(`summarising ${sectionPlans.length} sections`);
    const sectionRun = await executeTasks(ctx, runId, doc, sectionPlans);
    for (const c of sectionRun.collected) {
      const suffix = c.taskId.slice(c.taskId.lastIndexOf(':') + 1).split('/')[0];
      const idx = Number(suffix.replace(/^s/, ''));
      if (!Number.isFinite(idx) || !sections[idx]) continue;
      const valid = new Set(sections[idx].itemIds);
      const kept = keepCitedSentences(c.items as never[], valid);
      sections[idx].sentences.push(...kept.kept);
      sections[idx].dropped += kept.dropped;
    }
  }

  const sectionSentences = sections.flatMap((s) =>
    s.sentences.map((sentence, j) => ({ id: `S${s.section}-${j + 1}`, text: sentence.text, cites: sentence.cites })),
  );
  let overview: RollupSentence[] = [];
  if (sectionSentences.length > 0) {
    progress('writing overview');
    const target = overviewTargetSentenceCount(sectionSentences.length);
    const overviewPlan: TaskPlan = {
      suffix: 'ov',
      promptVersion: 'overview-v1',
      prompt: OVERVIEW_PROMPT,
      input: `${defsContext}\n\nWrite about ${target} sentences.\nItems:\n${JSON.stringify(sectionSentences)}`,
      maxTokens: Math.max(800, Math.min(2000, target * 80)),
      validate: (x) => typeof x === 'object' && x !== null,
    };
    const ovRun = await executeTasks(ctx, runId, doc, [overviewPlan]);
    const valid = new Set(sectionSentences.map((s) => s.id));
    for (const s of sectionSentences) for (const cite of s.cites) valid.add(cite);
    for (const c of ovRun.collected) overview.push(...keepCitedSentences(c.items as never[], valid).kept);
  }

  // 5. Cross-clause pass + whole-document search before any "missing" claim.
  const structure = verifiedClauses.map((c) => ({
    clause: c.clauseNo,
    itemId: c.itemId,
    summary: c.summary,
    type: c.type,
    dates: c.dates.map((d) => ({ text: d.text, timing_type: d.timing_type, itemId: d.itemId })),
    payments: c.payments.map((p) => ({ due: p.due, amount: p.amount, itemId: p.itemId })),
  }));
  const contradictions = findContradictions(structure);
  const gaps: CrossClauseResult['findings'] = [];
  for (const candidate of missingTopicCandidates(verifiedClauses.map((c) => ({ summary: c.summary, type: c.type })))) {
    let found = false;
    let checked = true;
    try {
      const hits = await opts.docSearch(candidate.label, 5);
      if (!Array.isArray(hits)) throw new Error('document search returned no result list');
      found = hits.some((h) => h.fused > 0);
    } catch (e) {
      checked = false;
      log(`document search failed for "${candidate.label}": ${String(e)}`);
    }
    if (checked && !found) {
      gaps.push({
        kind: 'gap',
        text: `No structured item covers ${candidate.label}; the whole-document hybrid search found nothing relevant either.`,
        itemIds: [],
        severity: 'medium',
      });
    }
  }
  const crossClause: CrossClauseResult = {
    findings: [...contradictions, ...gaps],
    payments: paymentTotals(
      verifiedClauses.flatMap((c) =>
        c.payments.map((p) => ({
          itemId: p.itemId,
          clause: c.clauseNo,
          amount: p.amount,
          payer: p.payer,
          payee: p.payee,
          due: p.due,
          page: p.page,
        })),
      ),
    ),
  };

  // 6. Coverage ledger, including skipped clauses.
  const ledgerInput: LedgerChunkInput[] = chunks.map((chunk) => {
    const prefix = `${runId}:a${chunk.index}`;
    const processed = first.tasks.some((t) => (t.id === prefix || t.id.startsWith(`${prefix}/`)) && t.status === 'done');
    const analysed = (rawByChunk.get(chunk.index) ?? [])
      .filter(isValidClauseItem)
      .map((c) => topClause(String((c as Record<string, unknown>).clause_no ?? '')))
      .filter((c) => chunk.manifest.some((m) => topClause(m) === c));
    const verified = verifiedClauses
      .filter((c) => c.chunkIndex === chunk.index && c.verifiedItems > 0)
      .map((c) => topClause(c.clauseNo));
    const analysedSet = new Set(analysed);
    const skipped = chunk.manifest.map((m) => topClause(m)).filter((m) => !analysedSet.has(m));
    const itemsAnalysed = (rawByChunk.get(chunk.index) ?? [])
      .filter(isValidClauseItem)
      .reduce<number>((n, c) => {
        const o = c as Record<string, unknown>;
        return n + ['obligations', 'dates', 'payments', 'risks'].reduce<number>((m, k) => m + arrOf(o[k]).length, 0);
      }, 0);
    return {
      chunkId: `analysis:${chunk.index}`,
      index: chunk.index,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      processed,
      detectedClauses: [...new Set(chunk.manifest.map((m) => topClause(m)))],
      analysedClauses: [...new Set(analysed)],
      verifiedClauses: [...new Set(verified)],
      skippedClauses: [...new Set(skipped)],
      itemsAnalysed,
      itemsVerified: verifiedClauses.filter((c) => c.chunkIndex === chunk.index).reduce((n, c) => n + c.verifiedItems, 0),
    };
  });
  const ledger = buildLedger(ledgerInput);
  ledger.totals.citedPages = [...new Set(verifiedClauses.flatMap((c) =>
    [...c.obligations, ...c.dates, ...c.payments, ...c.risks].map((i) => i.page),
  ))].sort((a, b) => a - b);

  // 7. Deterministic amount extraction and coverage.
  const codeAmounts = extractAmounts(index);
  const uncaptured = uncapturedAmounts(
    codeAmounts,
    verifiedClauses.flatMap((c) => c.payments.map((p) => ({ clause: c.clauseNo, amount: p.amount, quote: p.quote }))),
  );

  const metrics = await computeMetrics(db, await db.getAllFromIndex('tasks', 'byRun', runId));

  const report: AnalysisReport = {
    docId,
    docHash: doc.hash,
    docName: doc.name,
    runId,
    createdAt: Date.now(),
    model: opts.model,
    lawVersion: LAW_STANDIN_VERSION,
    definitions: {
      parties: sheet.parties.map((p) => ({ name: p.name, role: p.role })),
      defined_terms: sheet.defined_terms,
      key_dates: sheet.key_dates,
    },
    clauses: verifiedClauses,
    overview,
    sections,
    crossClause,
    ledger,
    metrics,
    drops,
    amounts: { code: codeAmounts, uncaptured },
    resolution: { pageCorrected, dropped: drops.length, skippedClauses: ledger.totals.clausesSkipped },
    notices: [
      'AI-assisted, requires lawyer review.',
      'Law passages are PLACEHOLDER test data; every law-based risk is applicability unverified.',
      'Only quotes verified against the stored page text are shown.',
    ],
  };

  await db.put('analysis_reports', { runId, docId, report, savedAt: Date.now() });
  await db.put('analysis_state', {
    docId,
    lastRunId: runId,
    maxTokens: metrics.recommendedMaxTokens ?? budget,
    p95CompletionTokens: metrics.p95CompletionTokens,
    updatedAt: Date.now(),
  });
  const { error: saveErr } = await supabase.from('reports').insert({ run_id: runId, body: report, coverage: ledger });
  if (saveErr) log(`report save to Supabase failed: ${saveErr.message}`);
  await supabase.from('runs').update({ status: 'complete', updated_at: new Date().toISOString() }).eq('id', runId);
  progress(`report saved (${metrics.calls} calls, ${metrics.completionTokens} completion tokens)`);
  return report;
}

export async function restoreReportFromSupabase(supabase: SupabaseClient, docId: string): Promise<AnalysisReport | null> {
  const { data, error } = await supabase
    .from('reports')
    .select('body,created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error || !data) return null;
  for (const row of data) {
    const body = row.body as AnalysisReport | null;
    if (body && body.docId === docId) return body;
  }
  return null;
}
