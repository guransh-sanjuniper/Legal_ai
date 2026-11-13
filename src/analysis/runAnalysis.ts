import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, DocumentRecord } from '../runner/db';
import { getDefinitions, definitionsContext } from '../retrieval/definitions';
import { LAW_STANDIN_VERSION } from '../retrieval/config';
import { buildAnchorIndex, topClause, type AnchorIndex } from './anchors';
import { buildAnalysisChunks, type AnalysisChunk } from './analysisChunks';
import { verifyQuotedItems } from './verify';
import { extractAmounts, uncapturedAmounts } from './amounts';
import { groupForRollup, keepCitedSentences } from './rollup';
import { buildLedger, type LedgerChunkInput } from './ledger';
import { dedupeVerifiedClauses } from './dedupe';
import { missingTopicCandidates, paymentTotals, type CrossFinding } from './crossClause';
import { findInconsistencies } from './inconsistencyChecks';
import { inferAffects, protectsFromDrop } from './riskGuard';
import { dropGapClaims, fallbackSummary } from './summaryGuard';
import { normaliseClauseNo } from './reportModel';
import { selectStatutoryLaws } from './statutory';
import { blankAffectsTerm, extractDraftingIssues } from './textQuality';
import {
  buildClausePrompt,
  buildExecutiveSummaryPrompt,
  buildPromptSynthesisPrompt,
  buildOverviewFocusPrompt,
  buildStatutoryPrompt,
  buildOverviewPrompt,
  DISPUTE_POINT,
  EXIT_POINT,
  OVERVIEW_POINTS,
  SECTION_PROMPT,
  SUMMARY_POINT,
} from './prompts';
import { computeMetrics, createRun, executeTasks, type ExecuteContext, type ExecuteResult, type TaskPlan } from './execute';
import { INITIAL_MAX_TOKENS, ANALYSIS_TIMEOUT_MS, OVERVIEW_TOKENS_PER_SENTENCE } from './config';
import { normaliseRequest, OVERVIEW_SENTENCES_PER_POINT, type AnalysisRequestInput } from './request';
import type { MissingStats, SummaryStats } from './types';
import { NO_SUGGESTION, guardPriority, lawKey, normaliseLaws, normaliseMissing, normaliseProse, riskBasisOf } from './rubric';
import {
  hitCoversTopic,
  isValidMissingItem,
  keepMissingClaims,
  missingGroups,
  missingPlanFor,
  type MissingInputClause,
} from './missingProtections';
import {
  assembleOverviewPoints,
  keepPointSentences,
  lawsEngaged,
  statutorySentences,
  type ModelPointSentence,
} from './overviewPoints';
import { synthesiseAnswers } from './promptPass';
import { answersAboutQuestion } from './answerGuard';
import { normalizeQuote } from './verify';
import {
  applyVerdicts,
  duplicateRiskIds,
  isValidVerdictItem,
  riskReviewPlans,
  type RiskReviewItem,
  type RiskVerdictItem,
} from './riskReview';
import type { Task } from '../tasks/types';
import { countWaivedPages } from '../ingest/review';
import type {
  AnalysisReport,
  CrossClauseResult,
  DropRecord,
  MissingProtection,
  PromptResult,
  RiskReviewStats,
  RollupSentence,
  SectionSummary,
  VerifiedClause,
  VerifiedDate,
  VerifiedObligation,
  VerifiedPayment,
  VerifiedRisk,
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
  keywordScore?: number;
  windowText?: string;
}

export interface AnalysisOptions {
  db: HarnessDBHandle;
  supabase: SupabaseClient;
  accessToken: string;
  refreshAccessToken?: (force?: boolean) => Promise<string | null>;
  userId?: string | null;
  functionsUrl: string;
  anonKey: string;
  docId: string;
  model: string;
  fallbackModel: string | null;
  reasoning?: { effort: 'minimal' } | null;
  maxTokens?: number | null;
  // Law search is no longer called from the risk path (no law text is loaded). Kept for the dev tools.
  lawSearch: (text: string, k: number) => Promise<LawHitLite[]>;
  request?: AnalysisRequestInput;
  // With resumeRunId: re-run failed tasks of this run, then rebuild the report from stored results.
  retryFailed?: boolean;
  onRunCreated?: (runId: string) => void;
  docSearch: (query: string, k: number) => Promise<SearchHitLite[]>;
  onProgress?: (msg: string) => void;
  onLog?: (msg: string) => void;
  maxFailureRate?: number;
  autoReduceConcurrency?: boolean;
  maxConsecutive429?: number;
  resumeRunId?: string;
  callModel?: (req: import('../tasks/types').CallRequest) => Promise<import('../tasks/types').CallResult>;
}

export class RateLimitedPause extends Error {
  constructor(
    public runId: string,
    public retryAfterMs: number,
  ) {
    super('paused: rate limited');
  }
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


// Chunk index from a task id such as "<run>:a3" or "<run>:r3/retry0" (-1 when not a chunk task).
export function taskChunkIndex(taskId: string): number {
  const suffix = taskId.slice(taskId.lastIndexOf(':') + 1).split('/')[0];
  const m = /^[a-z]+(\d+)$/.exec(suffix);
  return m ? Number(m[1]) : -1;
}

interface RawObligation {
  party?: unknown;
  text?: unknown;
  page?: unknown;
  quote?: unknown;
}
interface RawDate {
  text?: unknown;
  purpose?: unknown;
  timing_type?: unknown;
  page?: unknown;
  quote?: unknown;
}
interface RawPayment {
  amount?: unknown;
  purpose?: unknown;
  payer?: unknown;
  payee?: unknown;
  due?: unknown;
  page?: unknown;
  quote?: unknown;
}
interface RawPromptAnswer {
  page?: unknown;
  quote?: unknown;
  clause_no?: unknown;
}
interface RawRisk {
  text?: unknown;
  priority?: unknown;
  severity?: unknown;
  basis?: unknown;
  suggestion?: unknown;
  laws?: unknown;
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
    chunk.pageMarkedText,
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
  const request = normaliseRequest(opts.request);
  const clausePrompt = buildClausePrompt({
    docType: doc.docType ?? null,
    detail: request.detailLevel,
    focus: request.focus,
    reviewingFor: request.reviewingFor,
    customPrompt: request.customPrompt || undefined,
  });
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
    refreshAccessToken: opts.refreshAccessToken,
    userId: opts.userId,
    functionsUrl: opts.functionsUrl,
    anonKey: opts.anonKey,
    model: opts.model,
    fallbackModel: opts.fallbackModel,
    reasoning: opts.reasoning ?? null,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    onLog: log,
    maxFailureRate: opts.maxFailureRate,
    autoReduceConcurrency: opts.autoReduceConcurrency ?? true,
    maxConsecutive429: opts.maxConsecutive429 ?? 10,
    callModel: opts.callModel,
    rerunFailed: opts.retryFailed ?? false,
  };

  let runId: string;
  let priorEvents = 0;
  let priorWaitMs = 0;
  if (opts.resumeRunId) {
    runId = opts.resumeRunId;
    const { data } = await supabase
      .from('runs')
      .select('rate_limit_events,rate_limit_wait_ms')
      .eq('id', runId)
      .maybeSingle();
    priorEvents = Number(data?.rate_limit_events ?? 0);
    priorWaitMs = Number(data?.rate_limit_wait_ms ?? 0);
    await supabase
      .from('runs')
      .update({ status: 'running', paused_reason: null, retry_after: null, updated_at: new Date().toISOString() })
      .eq('id', runId);
    progress(`resuming run ${runId.slice(0, 8)}`);
  } else {
    runId = await createRun(ctx, doc);
  }
  // Lets the caller remember the run before it finishes, so a reload can resume it.
  opts.onRunCreated?.(runId);

  // 1. Clause analysis, one task per analysis chunk, every clause number requested.
  const plans: TaskPlan[] = chunks.map((chunk) => ({
    suffix: `a${chunk.index}`,
    promptVersion: 'clause-analysis-v3',
    prompt: clausePrompt,
    input: clauseInput(chunk, pages, defsContext, chunk.manifest),
    maxTokens: budget,
    validate: isValidClauseItem,
  }));
  progress(`analysing ${plans.length} chunks`);
  const first = await executeTasks(ctx, runId, doc, plans);
  let rateLimitEvents = priorEvents;
  let rateLimitWaitMs = priorWaitMs;
  const addLimits = (r: ExecuteResult) => {
    rateLimitEvents += r.rateLimitEvents;
    rateLimitWaitMs += r.rateLimitWaitMs;
  };
  const pauseIfNeeded = async (r: ExecuteResult) => {
    if (!r.pausedReason) return;
    await supabase
      .from('runs')
      .update({
        status: 'paused',
        paused_reason: r.pausedReason,
        retry_after: new Date(Date.now() + r.pausedRetryAfterMs).toISOString(),
        rate_limit_events: rateLimitEvents,
        rate_limit_wait_ms: rateLimitWaitMs,
        updated_at: new Date().toISOString(),
      })
      .eq('id', runId);
    throw new RateLimitedPause(runId, r.pausedRetryAfterMs);
  };
  addLimits(first);
  await pauseIfNeeded(first);

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

  if (first.aborted) {
    const counts = new Map<string, number>();
    for (const t of first.tasks) {
      if (t.status === 'failed') counts.set(t.failureCode ?? 'unknown', (counts.get(t.failureCode ?? 'unknown') ?? 0) + 1);
    }
    const summary = [...counts.entries()].map(([code, n]) => `${code}×${n}`).join(', ');
    throw new Error(`failure_rate_exceeded: ${first.failed} of ${first.tasks.length} first-pass tasks failed${summary ? ` (${summary})` : ''}`);
  }

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

  let retryTasks: typeof first.tasks = [];
  if (missingByChunk.size > 0) {
    const retryPlans: TaskPlan[] = [];
    for (const [indexNo, missing] of missingByChunk) {
      const chunk = chunks.find((c) => c.index === indexNo)!;
      const input = subsetInput(chunk, missing, index, defsContext) || clauseInput(chunk, pages, defsContext, missing);
      retryPlans.push({
        suffix: `r${indexNo}`,
        promptVersion: 'clause-analysis-v3',
        prompt: clausePrompt,
        input,
        maxTokens: Math.min(budget, 1200),
        validate: isValidClauseItem,
      });
    }
    progress(`retrying ${retryPlans.length} chunks with skipped clauses`);
    const retry = await executeTasks(ctx, runId, doc, retryPlans);
    addLimits(retry);
    await pauseIfNeeded(retry);
    retryTasks = retry.tasks;
    collect(retry.collected, 'r');
  }

  // 2b. Retry failed clause chunks once more after the pass, with a backoff delay.
  const doneIndexes = new Set<number>();
  const failedIndexes = new Set<number>();
  for (const t of [...first.tasks, ...retryTasks]) {
    const suffix = t.id.slice(t.id.lastIndexOf(':') + 1).split('/')[0];
    const m = /^[ar](\d+)$/.exec(suffix);
    if (!m) continue;
    const indexNo = Number(m[1]);
    if (t.status === 'done') doneIndexes.add(indexNo);
    else if (t.status === 'failed') failedIndexes.add(indexNo);
  }
  for (const i of doneIndexes) failedIndexes.delete(i);
  let secondRetryTasks: typeof first.tasks = [];
  if (failedIndexes.size > 0) {
    const retryPlans: TaskPlan[] = [...failedIndexes].map((indexNo) => {
      const chunk = chunks.find((c) => c.index === indexNo)!;
      return {
        suffix: `x${indexNo}`,
        promptVersion: 'clause-analysis-v3',
        prompt: clausePrompt,
        input: clauseInput(chunk, pages, defsContext, chunk.manifest),
        maxTokens: budget,
        delayMs: 5000,
        validate: isValidClauseItem,
      };
    });
    progress(`retrying ${retryPlans.length} failed chunks with backoff`);
    const retry = await executeTasks(ctx, runId, doc, retryPlans);
    addLimits(retry);
    await pauseIfNeeded(retry);
    secondRetryTasks = retry.tasks;
    collect(retry.collected, 'x');
  }

  // Clauses still not received after the focused retry are skipped, not silently treated as empty.
  const stillMissing = new Set<number>();
  for (const chunk of chunks) {
    const received = new Set(
      (rawByChunk.get(chunk.index) ?? [])
        .filter(isValidClauseItem)
        .map((x) => topClause(String((x as Record<string, unknown>).clause_no ?? ''))),
    );
    if (chunk.manifest.some((c) => !received.has(topClause(c)))) stillMissing.add(chunk.index);
  }
  const clauseTasks = [...first.tasks, ...retryTasks, ...secondRetryTasks].filter((t) => /:(?:a|r|x)\d+(?:\/|$)/.test(t.id));
  // A chunk that finished on any pass is not failed, even if an earlier pass for it failed (retry-failed case).
  const finishedChunks = new Set(clauseTasks.filter((t) => t.status === 'done').map((t) => taskChunkIndex(t.id)));
  const seenFailedTasks = new Set<string>();
  const failedClauseTasks = clauseTasks.filter((t) => {
    if (t.status !== 'failed' || seenFailedTasks.has(t.id) || finishedChunks.has(taskChunkIndex(t.id))) return false;
    seenFailedTasks.add(t.id);
    return true;
  });
  const partialNow = failedClauseTasks.length > 0 || stillMissing.size > 0;

  // 2c. The custom prompt is answered inside the clause call (promptAnswer), with no extra pass.
  // 3. Verification (code). Page and clause come from the resolver.
  let verifiedClauses: VerifiedClause[] = [];
  const drops: DropRecord[] = [];
  const promptLocated: import('./verify').Located<RawPromptAnswer>[] = [];
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
      const base = `C${chunk.index}:${seenClauses.size}:${codeClause || rawClause}`;

      if (request.customPrompt) {
        const pa = verifyQuotedItems<RawPromptAnswer>('promptAnswer', arrOf<RawPromptAnswer>(item.promptAnswer), index, range);
        for (const v of pa.verified) promptLocated.push(v);
      }

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
        purpose: str(v.item.purpose).trim(),
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
        purpose: str(v.item.purpose).trim(),
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
        const basis = riskBasisOf(v.item.basis);
        vRisks.push({
          itemId: `${base}:r${i}`,
          clause: v.item.clause,
          text: str(v.item.text),
          severity: guardPriority(v.item.priority ?? v.item.severity, basis),
          basis,
          suggestion: str(v.item.suggestion).trim() || NO_SUGGESTION,
          laws: normaliseLaws(v.item.laws),
          page: v.item.page,
          quote: v.item.quote,
          verified: true,
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
        missing: normaliseMissing(item.missing),
        prose: normaliseProse(item.prose),
      });
    }
  }
  const analysisMode = chunks[0]?.mode ?? 'structure';
  const deduped = dedupeVerifiedClauses(verifiedClauses, { dropEmpty: analysisMode === 'structure-free' });
  verifiedClauses = deduped.clauses;
  const dedupeStats = deduped.stats;
  progress(
    `verified ${verifiedClauses.length} clauses, dropped ${drops.length} unverified items, corrected ${pageCorrected} pages, ` +
      `deduped ${dedupeStats.removed} repeated items`,
  );

  // 2d. Inline custom prompt: verified promptAnswer quotes from the clause calls, then one
  // synthesis. There is no separate per-chunk prompt pass.
  let promptResult: PromptResult | undefined;
  if (request.customPrompt) {
    // Retry: the synthesis input changed when clause tasks were re-run, so run it again.
    if (opts.retryFailed) {
      const ps = await db.get('tasks', `${runId}:ps`);
      if (ps) {
        await db.put('tasks', {
          ...ps,
          status: 'queued',
          prompt: buildPromptSynthesisPrompt(),
          promptVersion: 'prompt-synthesis-v4',
          failureCode: null,
          failureMessage: null,
          nextAt: 0,
          updatedAt: Date.now(),
        });
      }
    }
    const seenQuote = new Set<string>();
    const answers = promptLocated
      .filter((v) => {
        const key = `${v.item.page}|${normalizeQuote(v.item.quote)}`;
        if (seenQuote.has(key)) return false;
        seenQuote.add(key);
        return true;
      })
      .map((v, i) => ({
        itemId: `PQ${i + 1}`,
        text: v.item.quote.trim(),
        clause: v.item.clause,
        page: v.item.page,
        quote: v.item.quote,
        verified: true as const,
        part: 'support' as const,
      }));
    progress(`custom prompt: ${answers.length} verified quote(s) from the clause calls`);
    const synth = await synthesiseAnswers({ ctx, runId, doc, prompt: request.customPrompt, answers });
    for (const r of synth.runs) {
      addLimits(r);
      await pauseIfNeeded(r);
    }
    const failedCodes = [...new Set(synth.runs.flatMap((r) => r.tasks).filter((t) => t.status === 'failed').map((t) => t.failureCode ?? 'failed'))];
    promptResult = {
      prompt: request.customPrompt,
      // Only quotes that state the request's subject are shown as support.
      answers: answersAboutQuestion(answers, request.customPrompt),
      answer: synth.answer,
      mode: 'inline',
      chunksTotal: chunks.length,
      chunksDone: chunks.length,
      failedChunks: [],
      ...(failedCodes.length
        ? { error: `Answer generation failed (${failedCodes.join(', ')}). The verified quotes are listed below.` }
        : {}),
    };
  }

  // 3a. Risk validation: a batched review of High and Medium risks, plus duplicate removal.
  // Low risks are not sent. A failed batch leaves its risks as proposed (fail open).
  let riskReview: RiskReviewStats | undefined;
  const reviewable: RiskReviewItem[] = verifiedClauses.flatMap((c) =>
    c.risks
      .filter((r) => r.severity !== 'low')
      .map((r) => ({ id: r.itemId, clause: c.clauseNo, priority: r.severity, issue: r.text, quote: r.quote })),
  );
  if (reviewable.length > 0) {
    const duplicates = duplicateRiskIds(reviewable);
    const toReview = reviewable.filter((r) => !duplicates.has(r.id));
    progress(`reviewing ${toReview.length} high and medium risks`);
    const reviewRun = toReview.length
      ? await executeTasks(ctx, runId, doc, riskReviewPlans(toReview))
      : null;
    if (reviewRun) {
      addLimits(reviewRun);
      await pauseIfNeeded(reviewRun);
    }
    const verdicts = (reviewRun?.collected.flatMap((c) => c.items) ?? []).filter(
      isValidVerdictItem,
    ) as RiskVerdictItem[];
    const applied = applyVerdicts(verdicts);
    // A term that puts a cost or liability on a named party can be downgraded, never dropped.
    const partyNames = sheet.parties.map((p) => p.name);
    const protectedIds = new Set(
      toReview.filter((r) => applied.dropped.has(r.id) && protectsFromDrop({ issue: r.issue, quote: r.quote }, partyNames)).map((r) => r.id),
    );
    for (const r of toReview) {
      if (protectedIds.has(r.id)) log(`validation kept ${r.id}: cost or liability placed on a party`);
    }
    const droppedIds = new Set<string>([...[...applied.dropped].filter((id) => !protectedIds.has(id)), ...duplicates]);
    const verdictDrops = [...droppedIds].filter((id) => !duplicates.has(id)).length;
    riskReview = {
      reviewed: toReview.length,
      kept: toReview.length - verdictDrops - applied.downgraded.size,
      downgraded: [...applied.downgraded].filter((id) => !duplicates.has(id) && !droppedIds.has(id)).length,
      dropped: duplicates.size + verdictDrops,
      drops: toReview
        .filter((r) => droppedIds.has(r.id))
        .map((r) => ({
          clause: r.clause,
          issue: r.issue,
          reason:
            duplicates.has(r.id)
              ? 'duplicate of another risk for the same clause and issue'
              : (verdicts.find((v) => v.id === r.id) as RiskVerdictItem | undefined)?.reason || 'dropped by validation',
        })),
    };
    verifiedClauses = verifiedClauses.map((c) => {
      const risks = c.risks
        .filter((r) => !droppedIds.has(r.itemId))
        .map((r) => (applied.downgraded.has(r.itemId) ? { ...r, severity: 'low' as const } : r));
      const verifiedItems = c.obligations.length + c.dates.length + c.payments.length + risks.length;
      return { ...c, risks, verifiedItems };
    });
    for (const d of riskReview.drops ?? []) log(`validation dropped clause ${d.clause}: ${d.issue} (${d.reason})`);
    progress(
      `${riskReview.reviewed} risks reviewed: ${riskReview.kept} kept, ${riskReview.downgraded} downgraded, ${riskReview.dropped} dropped`,
    );
  }

  // Which party each risk affects: the risk's own text first, then its clause's parties.
  verifiedClauses = verifiedClauses.map((c) => ({
    ...c,
    risks: c.risks.map((r) =>
      r.affects && r.affects.trim()
        ? r
        : {
            ...r,
            affects: inferAffects({
              issue: r.text,
              quote: r.quote,
              clauseParties: [...new Set(c.obligations.map((o) => o.party))],
              partyNames: sheet.parties.map((p) => p.name),
            }),
          },
    ),
  }));

  // 3b. Missing protections: model check over clause summaries; each claim needs a whole-document search miss.
  let missingProtections: MissingProtection[] = [];
  let possiblyMissing: MissingProtection[] = [];
  let missingStats: MissingStats = { proposed: 0, kept: 0, droppedCovered: 0, possiblyMissing: 0, passRan: false };
  let missingUnchecked = 0;
  let missingFailed = 0;
  let missingDrops: { topic: string; page: number; fused: number; keywordScore: number }[] = [];
  let missingRawItems = 0;
  let missingRejected = 0;
  if (verifiedClauses.length > 0) {
    const clauseInputs: MissingInputClause[] = verifiedClauses.map((c) => ({
      id: c.itemId,
      clause: c.clauseNo,
      type: c.type,
      summary: c.summary,
    }));
    progress(`checking missing protections (${clauseInputs.length} clauses)`);
    const present = [...new Set(clauseInputs.map((c) => c.clause).filter(Boolean))];
    const planOpts = {
      defsContext,
      focus: request.focus,
      docType: doc.docType ?? null,
      reviewingFor: request.reviewingFor,
      present,
    };
    const groups = missingGroups(clauseInputs);
    const firstPass = await executeTasks(ctx, runId, doc, groups.map((g, i) => missingPlanFor(g, `m${i}`, planOpts)));
    addLimits(firstPass);
    await pauseIfNeeded(firstPass);
    const runs = [firstPass];

    // A group cut off at the output cap is retried as two smaller calls, not with a bigger cap.
    const truncated = firstPass.tasks.filter((t) => t.status === 'failed' && t.failureCode === 'length');
    if (truncated.length > 0) {
      const retryPlans: TaskPlan[] = [];
      for (const task of truncated) {
        const suffix = task.id.slice(task.id.lastIndexOf(':') + 1).split('/')[0];
        const m = /^m(\d+)$/.exec(suffix);
        const group = m ? groups[Number(m[1])] : undefined;
        if (!group || group.length < 2) continue;
        const mid = Math.ceil(group.length / 2);
        [group.slice(0, mid), group.slice(mid)].forEach((half, h) =>
          retryPlans.push(missingPlanFor(half, `m${m![1]}s${h}`, { ...planOpts, maxTokens: 1200 })),
        );
      }
      if (retryPlans.length > 0) {
        progress(`splitting ${truncated.length} over-length missing-protection calls`);
        const retryRun = await executeTasks(ctx, runId, doc, retryPlans);
        addLimits(retryRun);
        await pauseIfNeeded(retryRun);
        runs.push(retryRun);
      }
    }
    missingFailed = runs.flatMap((r) => r.tasks).filter((t) => t.status === 'failed').length;
    missingRawItems = runs.reduce((n, r) => n + r.rawItems, 0);
    missingRejected = runs.reduce((n, r) => n + r.rejected.reduce((m, x) => m + x.count, 0), 0);
    const validClauseIds = new Set(verifiedClauses.map((c) => c.itemId));
    const checked = await keepMissingClaims(
      runs.flatMap((r) => r.collected).flatMap((c) => c.items.filter(isValidMissingItem)),
      validClauseIds,
      opts.docSearch,
    );
    missingProtections = checked.kept;
    possiblyMissing = checked.possiblyMissing;
    missingUnchecked = checked.unchecked;
    missingStats = {
      proposed: checked.proposed,
      kept: checked.kept.length,
      droppedCovered: checked.coveredInDocument,
      possiblyMissing: checked.possiblyMissing.length,
      passRan: true,
      rawItems: missingRawItems,
      rejectedBySchema: missingRejected,
      tasksDone: runs.flatMap((r) => r.tasks).filter((t) => t.status === 'done').length,
      tasksFailed: missingFailed,
    };
    missingDrops = checked.drops;
    progress(
      `missing protections: ${checked.proposed} proposed, ${checked.kept.length} kept, ${checked.coveredInDocument} dropped by search, ` +
        `${checked.possiblyMissing.length} unverified`,
    );
  }

  // 3c. Placeholders and reviewer comments, found by code. A blank that touches money, time or a
  // party adds one Medium risk to its clause. Comment text is never analysed as a term.
  const draftingIssues = extractDraftingIssues(pages, index);
  if (draftingIssues.blankCount > 0) {
    const groupsByClause = new Map<string, typeof draftingIssues.groups>();
    for (const g of draftingIssues.groups) {
      if (g.blanks.length === 0) continue;
      const key = normaliseClauseNo(g.clause);
      groupsByClause.set(key, [...(groupsByClause.get(key) ?? []), g]);
    }
    verifiedClauses = verifiedClauses.map((c) => {
      const groups = groupsByClause.get(normaliseClauseNo(c.clauseNo)) ?? [];
      const lines = groups.flatMap((g) => g.blanks.filter(blankAffectsTerm).map((line) => ({ line, page: g.page })));
      if (lines.length === 0) return c;
      const added: VerifiedRisk[] = lines.slice(0, 3).map((entry, i) => ({
        itemId: `${c.itemId}:blank${i}`,
        clause: c.clauseNo,
        text: 'An operative term is left blank, so the obligation is incomplete.',
        severity: 'medium',
        basis: 'other',
        suggestion: 'Fill the blank with the agreed term, or delete the reference before execution.',
        laws: [],
        affects: 'Both/unclear',
        page: entry.page,
        quote: entry.line,
        verified: true,
        applicability: 'unverified',
      }));
      const risks = [...c.risks, ...added];
      return { ...c, risks, verifiedItems: c.obligations.length + c.dates.length + c.payments.length + risks.length };
    });
  }

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
  const applySectionCollected = (collected: { taskId: string; items: unknown[] }[]) => {
    for (const c of collected) {
      const suffix = c.taskId.slice(c.taskId.lastIndexOf(':') + 1).split('/')[0];
      const m = /^s(\d+)/.exec(suffix);
      const idx = m ? Number(m[1]) : NaN;
      if (!Number.isFinite(idx) || !sections[idx]) continue;
      const valid = new Set(sections[idx].itemIds);
      const kept = keepCitedSentences(c.items as never[], valid);
      sections[idx].sentences.push(...kept.kept);
      sections[idx].dropped += kept.dropped;
    }
  };
  if (sectionPlans.length > 0) {
    progress(`summarising ${sectionPlans.length} sections`);
    const sectionRun = await executeTasks(ctx, runId, doc, sectionPlans);
    addLimits(sectionRun);
    await pauseIfNeeded(sectionRun);
    applySectionCollected(sectionRun.collected);

    // A section summary that hit the output limit is split into two smaller groups, not failed.
    const failedSections = sectionRun.tasks.filter((t) => t.status === 'failed' && t.failureCode === 'length');
    if (failedSections.length > 0) {
      const retryPlans: TaskPlan[] = [];
      for (const task of failedSections) {
        const suffix = task.id.slice(task.id.lastIndexOf(':') + 1).split('/')[0];
        const m = /^s(\d+)/.exec(suffix);
        const idx = m ? Number(m[1]) : NaN;
        const group = Number.isFinite(idx) ? groups[idx] : undefined;
        if (!group || group.length < 2) continue;
        const mid = Math.ceil(group.length / 2);
        [group.slice(0, mid), group.slice(mid)].forEach((half, h) => {
          retryPlans.push({
            suffix: `s${idx}y${h}`,
            promptVersion: 'section-summary-v1',
            prompt: SECTION_PROMPT,
            input: `${defsContext}\n\nItems:\n${JSON.stringify(half)}`,
            maxTokens: Math.max(600, Math.min(1200, half.length * 30)),
            validate: (x) => typeof x === 'object' && x !== null && typeof (x as { text?: unknown }).text === 'string',
          });
        });
      }
      if (retryPlans.length > 0) {
        progress(`splitting ${failedSections.length} over-length section summaries`);
        const retryRun = await executeTasks(ctx, runId, doc, retryPlans);
        addLimits(retryRun);
        await pauseIfNeeded(retryRun);
        applySectionCollected(retryRun.collected);
      }
    }
  }

  const sectionSentences = sections.flatMap((s) =>
    s.sentences.map((sentence, j) => ({ id: `S${s.section}-${j + 1}`, text: sentence.text, cites: sentence.cites })),
  );
  // 5. Cross-clause pass + whole-document search before any "missing" claim.
  // Every inconsistency needs two verified quotes, a shared subject and a shared party.
  const contradictions: CrossFinding[] = findInconsistencies(verifiedClauses);
  const gaps: CrossClauseResult['findings'] = [];
  for (const candidate of missingTopicCandidates(verifiedClauses.map((c) => ({ summary: c.summary, type: c.type })))) {
    let found = false;
    let checked = true;
    try {
      const hits = await opts.docSearch(candidate.label, 5);
      if (!Array.isArray(hits)) throw new Error('document search returned no result list');
      found = hitCoversTopic(hits, candidate.label);
    } catch (e) {
      checked = false;
      log(`document search failed for "${candidate.label}": ${String(e)}`);
    }
    if (checked && !found) {
      gaps.push({
        kind: 'gap',
        text: partialNow
          ? `Unverified (some clauses not analysed): no structured item covers ${candidate.label}; the whole-document hybrid search found nothing relevant either.`
          : `No structured item covers ${candidate.label}; the whole-document hybrid search found nothing relevant either.`,
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

  // 5b. Overview: thirteen numbered points. Statutory Compliance, Notable Drafting Issues and
  // Internal Inconsistencies are built in code. Termination and dispute points are written from
  // focused evidence, and the Executive Summary only from the other points, risks and missing list.
  const findingItems = crossClause.findings.map((f, i) => ({ id: `F${i + 1}`, text: f.text, cites: f.itemIds }));
  const missingItems = missingProtections.map((m) => ({ id: m.itemId, text: `${m.topic}: ${m.text}`, cites: m.cites }));
  const inconsistencyFindings = crossClause.findings.filter((f) => f.kind !== 'gap');
  const inconsistencies: RollupSentence[] = inconsistencyFindings.length
    ? inconsistencyFindings.map((f) => ({ text: f.reason ? `${f.text} ${f.reason}` : f.text, cites: f.itemIds }))
    : [{ text: 'No inconsistency was found by the checks.', cites: [] }];

  // Notable Drafting Issues: counts and clause groups from the code extraction; empty when none.
  const notable: RollupSentence[] = [];
  const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
  if (draftingIssues.blankCount > 0) {
    notable.push({ text: `Unfilled blanks (${draftingIssues.blankCount}).`, cites: [] });
    for (const g of draftingIssues.groups) {
      if (g.blanks.length === 0) continue;
      notable.push({ text: `Clause ${g.clause}, page ${g.page}: ${g.blanks.map((b) => `“${clip(b)}”`).join('; ')}`, cites: [] });
    }
  }
  if (draftingIssues.commentCount > 0) {
    notable.push({ text: `Reviewer comments in text (${draftingIssues.commentCount}).`, cites: [] });
    for (const g of draftingIssues.groups) {
      if (g.comments.length === 0) continue;
      notable.push({ text: `Clause ${g.clause}, page ${g.page}: ${g.comments.map((b) => `“${clip(b)}”`).join('; ')}`, cites: [] });
    }
  }

  const overviewValid = new Set<string>([
    ...verifiedClauses.flatMap((c) => [c.itemId, ...c.risks.map((r) => r.itemId)]),
    ...sectionSentences.flatMap((s) => [s.id, ...s.cites]),
    ...findingItems.map((f) => f.id),
    ...missingItems.map((m) => m.id),
  ]);
  let modelSentences: ModelPointSentence[] = [];
  if (sectionSentences.length > 0 || findingItems.length > 0 || missingItems.length > 0) {
    progress('writing overview');
    const overviewPlan: TaskPlan = {
      suffix: 'ov',
      promptVersion: 'overview-points-v1',
      prompt: buildOverviewPrompt(request.detailLevel),
      input: `${defsContext}\n\nItems:\n${JSON.stringify({ sections: sectionSentences, findings: findingItems, missing: missingItems })}`,
      maxTokens: Math.max(800, Math.min(3000, 8 * OVERVIEW_SENTENCES_PER_POINT[request.detailLevel] * OVERVIEW_TOKENS_PER_SENTENCE)),
      validate: (x) => typeof x === 'object' && x !== null,
    };
    const ovRun = await executeTasks(ctx, runId, doc, [overviewPlan]);
    addLimits(ovRun);
    await pauseIfNeeded(ovRun);
    for (const c of ovRun.collected) modelSentences.push(...keepPointSentences(c.items, overviewValid).kept);
  }

  // Termination/exit and dispute/forum points: retrieve the clauses about those topics, then write
  // only those points from them. This keeps them filled when section summaries do not cover them.
  const focusTopics = [
    { point: EXIT_POINT, queries: ['termination', 'notice period', 'expiry renewal'], pattern: /terminat|expiry|expire|cancel|revok|renew|notice/i },
    {
      point: DISPUTE_POINT,
      queries: ['dispute resolution', 'arbitration', 'governing law jurisdiction'],
      pattern: /disput|arbitrat|jurisdiction|governing law|courts?\b/i,
    },
  ];
  const focusClauses = new Map<string, { id: string; clause: string; summary: string; risks: { id: string; text: string }[] }>();
  for (const topic of focusTopics) {
    for (const q of topic.queries) {
      try {
        const hits = await opts.docSearch(q, 6);
        for (const hit of hits) {
          for (const c of verifiedClauses) {
            if (c.pageEnd < hit.pageStart || c.pageStart > hit.pageEnd) continue;
            focusClauses.set(c.itemId, {
              id: c.itemId,
              clause: c.clauseNo,
              summary: c.summary,
              risks: c.risks.map((r) => ({ id: r.itemId, text: r.text })),
            });
          }
        }
      } catch (e) {
        log(`document search failed for "${q}": ${String(e)}`);
      }
    }
    // Fallback when search returns nothing: clauses whose own page text mentions the topic.
    for (const c of verifiedClauses) {
      if (focusClauses.has(c.itemId)) continue;
      if (!topic.pattern.test(pageInput(pages, c.pageStart, c.pageEnd))) continue;
      focusClauses.set(c.itemId, {
        id: c.itemId,
        clause: c.clauseNo,
        summary: c.summary,
        risks: c.risks.map((r) => ({ id: r.itemId, text: r.text })),
      });
    }
  }
  if (focusClauses.size > 0) {
    const evidence = [...focusClauses.values()];
    const focusValid = new Set(evidence.flatMap((c) => [c.id, ...c.risks.map((r) => r.id)]));
    progress('writing termination and dispute points');
    const plan: TaskPlan = {
      suffix: 'ovf',
      promptVersion: 'overview-focus-v1',
      prompt: buildOverviewFocusPrompt(
        request.detailLevel,
        focusTopics.map((t) => `${t.point} ${OVERVIEW_POINTS[t.point - 1]}`),
      ),
      input: `${defsContext}\n\nItems:\n${JSON.stringify({ points: focusTopics.map((t) => ({ point: t.point, title: OVERVIEW_POINTS[t.point - 1] })), clauses: evidence })}`,
      maxTokens: 1400,
      validate: (x) => typeof x === 'object' && x !== null,
    };
    const focusRun = await executeTasks(ctx, runId, doc, [plan]);
    addLimits(focusRun);
    await pauseIfNeeded(focusRun);
    for (const c of focusRun.collected) modelSentences.push(...keepPointSentences(c.items, focusValid).kept);
  }

  let summaryStats: SummaryStats | undefined;
  // Executive Summary: only the other points, the risks and the verified missing list.
  const pointItems = OVERVIEW_POINTS.slice(0, SUMMARY_POINT - 1)
    .map((title, i) => ({ id: `PT${i + 1}`, point: i + 1, title, text: '' }))
    .map((p) => {
      const sentences = modelSentences.filter((s) => s.point === p.point);
      return { ...p, text: sentences.map((s) => s.text).join(' ') };
    })
    .filter((p) => p.text);
  if (pointItems.length > 0) {
    progress('writing executive summary');
    const riskLines = verifiedClauses.flatMap((c) =>
      c.risks.filter((r) => r.severity !== 'low').map((r) => ({ id: r.itemId, text: `Clause ${c.clauseNo}: ${r.text}` })),
    );
    const plan: TaskPlan = {
      suffix: 'es',
      promptVersion: 'executive-summary-v1',
      prompt: buildExecutiveSummaryPrompt(),
      input: `${defsContext}\n\nItems:\n${JSON.stringify({ points: pointItems, risks: riskLines, missing: missingItems })}`,
      maxTokens: 1200,
      validate: (x) => typeof x === 'object' && x !== null,
    };
    const run = await executeTasks(ctx, runId, doc, [plan]);
    addLimits(run);
    await pauseIfNeeded(run);
    const valid = new Set<string>([...pointItems.map((p) => p.id), ...riskLines.map((r) => r.id), ...missingItems.map((m) => m.id)]);
    // Summary sentences carry no point number; validate their citations only.
    const raw = run.collected.flatMap((c) => keepCitedSentences(c.items as never[], valid).kept);
    const guarded = dropGapClaims(raw, missingProtections.length > 0);
    summaryStats = { rawItems: run.collected.flatMap((c) => c.items).length, kept: guarded.kept.length, droppedByGuard: guarded.dropped };
    log(`executive summary: ${summaryStats.rawItems} raw items, ${guarded.kept.length} kept, ${guarded.dropped} gap claims dropped`);
    modelSentences.push(...guarded.kept.map((k) => ({ point: SUMMARY_POINT, text: k.text, cites: k.cites })));
  }

  // Statutory Compliance: Acts engaged by a risk or missing item, plus the Acts central to the
  // document type. A proposed Act is kept only when it is central; unrelated Acts are omitted.
  let proposedLaws: string[] = [];
  if (verifiedClauses.length > 0) {
    const plan: TaskPlan = {
      suffix: 'laws',
      promptVersion: 'statutory-laws-v2',
      prompt: buildStatutoryPrompt(),
      input: `Document type: ${doc.docType ?? 'unknown'}\n\nClause summaries:\n${JSON.stringify(
        verifiedClauses.slice(0, 120).map((c) => ({ clause: c.clauseNo, type: c.type, summary: c.summary })),
      )}`,
      maxTokens: 400,
      validate: (x) => typeof x === 'string' && x.trim().length > 0,
    };
    const run = await executeTasks(ctx, runId, doc, [plan]);
    addLimits(run);
    await pauseIfNeeded(run);
    proposedLaws = run.collected
      .flatMap((c) => c.items as string[])
      .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  const engaged = lawsEngaged(verifiedClauses, missingProtections);
  const statutoryLaws = selectStatutoryLaws({
    engaged: engaged.map((l) => ({ name: l.name, clauses: l.clauses })),
    docType: doc.docType ?? null,
    proposed: proposedLaws,
  });
  const engagedByKey = new Map(engaged.map((l) => [lawKey(l.name), l.itemIds]));
  const statutory = statutorySentences(
    statutoryLaws.map((l) => ({ name: l.name, clauses: l.clauses, itemIds: engagedByKey.get(lawKey(l.name)) ?? [] })),
  );

  const overviewPoints = assembleOverviewPoints({ model: modelSentences, statutory, notable, inconsistencies });
  let overview: RollupSentence[] = overviewPoints.flatMap((p) => p.sentences).filter((s) => s.cites.length > 0);

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
  metrics.rateLimitEvents = rateLimitEvents;
  metrics.rateLimitWaitMs = rateLimitWaitMs;
  metrics.concurrency = first.concurrency;

  const totalClauses = ledger.totals.clausesDetected;
  const analysedClauses = ledger.totals.clausesAnalysed;
  const notAnalysed = Math.max(0, totalClauses - analysedClauses);

  const doneChunks = new Set<number>();
  const failedChunkMap = new Map<number, Task>();
  for (const t of clauseTasks) {
    const suffix = t.id.slice(t.id.lastIndexOf(':') + 1).split('/')[0];
    const indexNo = Number(suffix.slice(1));
    if (!Number.isFinite(indexNo)) continue;
    if (t.status === 'done') doneChunks.add(indexNo);
    if (t.status === 'failed') {
      const prev = failedChunkMap.get(indexNo);
      if (!prev || t.attemptNo >= prev.attemptNo) failedChunkMap.set(indexNo, t);
    }
  }
  for (const i of doneChunks) failedChunkMap.delete(i);
  const totalChunks = chunks.length;
  const analysedChunks = doneChunks.size;
  const totalPages = pages.size;
  const coveredPages = new Set<number>();
  for (const c of chunks) {
    if (!doneChunks.has(c.index)) continue;
    for (let p = c.pageStart; p <= c.pageEnd; p++) coveredPages.add(p);
  }
  const failedChunks = [...failedChunkMap.entries()].map(([chunkIndex, t]) => {
    const chunk = chunks.find((c) => c.index === chunkIndex);
    return {
      chunkIndex,
      pages: [chunk?.pageStart ?? 0, chunk?.pageEnd ?? 0] as [number, number],
      failureCode: t.failureCode,
      message: t.failureMessage,
    };
  });
  const partial = partialNow || (analysisMode === 'structure-free' ? failedChunks.length > 0 : notAnalysed > 0);
  const unreliable = clauseTasks.length > 0 && failedClauseTasks.length / clauseTasks.length > 0.1;
  const failedClauses = failedClauseTasks.map((t) => {
    const suffix = t.id.slice(t.id.lastIndexOf(':') + 1).split('/')[0];
    const indexNo = Number(suffix.slice(1));
    const chunk = chunks.find((c) => c.index === indexNo);
    return {
      taskId: t.id,
      clause: chunk ? chunk.clauses.join(', ') || chunk.clauseFrom || 'unknown' : 'unknown',
      pages: [chunk?.pageStart ?? 0, chunk?.pageEnd ?? 0] as [number, number],
      failureCode: t.failureCode,
      message: t.failureMessage,
    };
  });
  if (partial) {
    overview = [
      ...overview,
      {
        text:
          analysisMode === 'structure-free'
            ? `${analysedChunks} of ${totalChunks} chunks analysed; pages covered ${coveredPages.size} of ${totalPages}.`
            : `${notAnalysed} of ${totalClauses} clauses not analysed.`,
        cites: [],
      },
    ];
  }
  const chunking = {
    mode: chunks[0]?.mode ?? 'structure',
    modeReason: chunks[0]?.modeReason ?? '',
    chunkCount: chunks.length,
    longestChunkTokens: chunks.reduce((n, c) => Math.max(n, Math.ceil(c.text.length / 4)), 0),
    sectionBreaks: chunks.filter((c) => c.sectionBreak).length,
    longClauses: new Set(chunks.filter((c) => c.unusuallyLong).flatMap((c) => c.clauses)).size,
  };

  const unreviewedPages = await countWaivedPages(db, docId);
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
      'Law references are model knowledge; their applicability is unverified.',
      'Only quotes verified against the stored page text are shown.',
      ...(missingUnchecked > 0
        ? [`${missingUnchecked} missing-protection claim(s) could not be checked against the document and were left out.`]
        : []),
      ...(missingFailed > 0 ? [`Missing-protections check incomplete: ${missingFailed} group(s) failed.`] : []),
      ...(promptResult && promptResult.failedChunks.length > 0
        ? [`Custom prompt incomplete: ${promptResult.failedChunks.length} chunk(s) failed.`]
        : []),
      ...(partial
        ? [
            analysisMode === 'structure-free'
              ? `Report is partial: ${analysedChunks} of ${totalChunks} chunks analysed; pages covered ${coveredPages.size} of ${totalPages}.`
              : `Report is partial: ${notAnalysed} of ${totalClauses} clauses were not analysed.`,
          ]
        : []),
      ...(unreliable ? ['Unreliable: more than 10% of clause units failed.'] : []),
    ],
    partial,
    unreliable,
    unreviewedPages,
    failedClauses,
    coverage: {
      mode: analysisMode,
      totalClauses,
      analysedClauses,
      notAnalysed,
      totalChunks,
      analysedChunks,
      totalPages,
      pagesCovered: coveredPages.size,
      failedChunks,
    },
    dedupe: dedupeStats,
    chunking,
    request,
    chunkClauses: chunks.map((c) => ({ chunkIndex: c.index, clauses: [...new Set(c.clauses)] })),
    overviewPoints,
    missingProtections,
    possiblyMissing,
    missingStats,
    missingDrops,
    riskReview,
    draftingIssues,
    summaryStats,
    ...(promptResult ? { promptResult } : {}),
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
  await supabase
    .from('runs')
    .update({
      status: 'complete',
      paused_reason: null,
      retry_after: null,
      rate_limit_events: rateLimitEvents,
      rate_limit_wait_ms: rateLimitWaitMs,
      updated_at: new Date().toISOString(),
    })
    .eq('id', runId);
  progress(`report saved (${metrics.calls} calls, ${metrics.completionTokens} completion tokens)`);
  return report;
}

// Filters on the document inside the saved body, so older reports for other documents cannot push this one out.
export async function restoreReportFromSupabase(supabase: SupabaseClient, docId: string): Promise<AnalysisReport | null> {
  const { data, error } = await supabase
    .from('reports')
    .select('body,created_at')
    .eq('body->>docId', docId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const body = data[0].body as AnalysisReport | null;
  return body && body.docId === docId ? body : null;
}
