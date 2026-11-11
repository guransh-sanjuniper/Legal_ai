import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, ChunkRecord, DocumentRecord, PageRecord } from '../runner/db';
import { getDefinitions, definitionsContext } from '../retrieval/definitions';
import { LAW_STANDIN_VERSION } from '../retrieval/config';
import { buildUnits } from '../ingest/chunk';
import { verifyQuotedItems } from './verify';
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
  return new Map((pages as PageRecord[]).map((p) => [p.pageNo, p.text]));
}

function chunkInput(chunk: ChunkRecord, pages: Map<number, string>, defsContext: string): string {
  const parts: string[] = [];
  for (let p = chunk.pageStart; p <= chunk.pageEnd; p++) {
    const text = pages.get(p);
    if (text !== undefined) parts.push(`[page ${p}]\n${text}`);
  }
  return [defsContext, parts.join('\n')].filter(Boolean).join('\n\n');
}

function detectedClauses(chunk: ChunkRecord): string[] {
  const units = buildUnits([{ pageNo: chunk.pageStart, text: chunk.text }]);
  return [...new Set(units.map((u) => u.clauseNo).filter((c): c is string => c !== null))];
}

export async function runAnalysis(opts: AnalysisOptions): Promise<AnalysisReport> {
  const { db, supabase, docId } = opts;
  const log = opts.onLog ?? (() => {});
  const progress = opts.onProgress ?? (() => {});

  const doc: DocumentRecord | undefined = await db.get('documents', docId);
  if (!doc || doc.status !== 'ready' || !doc.prepFingerprint) throw new Error('document is not ready');
  const chunks = (await db.getAll('chunks', IDBKeyRange.bound(`${docId}:`, `${docId}:\uffff`))).sort((a, b) => a.index - b.index);
  const pages = await loadPageMap(db, docId);
  const sheet = await getDefinitions(db, docId);
  if (!sheet) throw new Error('build the definitions sheet on the Search page first');
  const defsContext = definitionsContext(sheet);

  const state = await db.get('analysis_state', docId);
  const budget = opts.maxTokens ?? state?.maxTokens ?? INITIAL_MAX_TOKENS;
  progress(`analysis budget: ${budget} max_tokens per task`);

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

  // 1. Clause analysis, one task per chunk, definitions sheet attached.
  const plans: TaskPlan[] = chunks.map((chunk, i) => ({
    suffix: `a${i}`,
    promptVersion: 'clause-analysis-v1',
    prompt: CLAUSE_PROMPT,
    input: chunkInput(chunk, pages, defsContext),
    maxTokens: budget,
    validate: isValidClauseItem,
  }));
  progress(`analysing ${plans.length} chunks`);
  const clauseRun = await executeTasks(ctx, runId, doc, plans);

  const clausesByChunk = new Map<number, unknown[]>();
  for (const c of clauseRun.collected) {
    const suffix = c.taskId.slice(c.taskId.lastIndexOf(':') + 1).split('/')[0];
    const index = Number(suffix.replace(/^a/, ''));
    if (!Number.isFinite(index)) continue;
    const list = clausesByChunk.get(index) ?? [];
    list.push(...c.items);
    clausesByChunk.set(index, list);
  }

  // 2. Verification (code) + 3. law lookup for risks.
  const lawCache = new Map<string, LawPassageRef[]>();
  const verifiedClauses: VerifiedClause[] = [];
  const drops: DropRecord[] = [];
  let lawCalls = 0;

  for (const chunk of chunks) {
    const rawItems = clausesByChunk.get(chunk.index) ?? [];
    let emitted = 0;
    for (const raw of rawItems) {
      if (!isValidClauseItem(raw)) continue;
      const item = raw as Record<string, unknown>;
      const clauseNo = str(item.clause_no).trim() || `#${++emitted}`;
      const base = `C${chunk.index}:${clauseNo}`;

      const obligations = verifyQuotedItems<RawObligation>('obligation', arrOf<RawObligation>(item.obligations), pages);
      const dates = verifyQuotedItems<RawDate>('date', arrOf<RawDate>(item.dates), pages);
      const payments = verifyQuotedItems<RawPayment>('payment', arrOf<RawPayment>(item.payments), pages);
      const risks = verifyQuotedItems<RawRisk>('risk', arrOf<RawRisk>(item.risks), pages);
      for (const r of [...obligations.drops, ...dates.drops, ...payments.drops, ...risks.drops]) {
        drops.push({ clauseNo, kind: r.kind, reason: r.reason, page: r.page, quote: r.quote });
      }

      const vObligations: VerifiedObligation[] = obligations.verified.map((v, i) => ({
        itemId: `${base}:ob${i}`,
        party: str(v.item.party),
        text: str(v.item.text),
        page: v.item.page,
        quote: v.item.quote,
        verified: true,
      }));
      const vDates: VerifiedDate[] = dates.verified.map((v, i) => ({
        itemId: `${base}:d${i}`,
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
        if (lawCalls < 40) {
          const key = `${clauseNo}|${riskText}`;
          if (lawCache.has(key)) passages = lawCache.get(key)!;
          else {
            try {
              const hits = await opts.lawSearch(`${str(item.summary)} ${riskText}`, 3);
              passages = hits.map((h) => ({
                id: h.id,
                title: h.title,
                text: h.text,
                fused: h.fused,
                lawVersion: h.lawVersion,
              }));
            } catch (e) {
              log(`law search failed for clause ${clauseNo}: ${String(e)}`);
            }
            lawCalls++;
            lawCache.set(key, passages);
          }
        }
        vRisks.push({
          itemId: `${base}:r${i}`,
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

      const verifiedItems = vObligations.length + vDates.length + vPayments.length + vRisks.length;
      verifiedClauses.push({
        itemId: base,
        clauseNo,
        type: str(item.type) || 'other',
        summary: str(item.summary),
        chunkId: chunk.id,
        chunkIndex: chunk.index,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        obligations: vObligations,
        dates: vDates,
        payments: vPayments,
        risks: vRisks,
        verifiedItems,
      });
    }
  }
  progress(`verified ${verifiedClauses.length} clauses, dropped ${drops.length} unverified items`);

  // 4. Roll-up as dependent tasks: section summaries, then the overview.
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
      const index = Number(suffix.replace(/^s/, ''));
      if (!Number.isFinite(index) || !sections[index]) continue;
      const valid = new Set(sections[index].itemIds);
      const kept = keepCitedSentences(c.items as never[], valid);
      sections[index].sentences.push(...kept.kept);
      sections[index].dropped += kept.dropped;
      // Uncited or invalid-ID sentences are dropped, never shown.
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
    // An overview sentence may cite a section id, or a clause item id that a kept section
    // sentence already cited. Both are valid.
    const valid = new Set(sectionSentences.map((s) => s.id));
    for (const s of sectionSentences) for (const cite of s.cites) valid.add(cite);
    for (const c of ovRun.collected) {
      const kept = keepCitedSentences(c.items as never[], valid);
      overview.push(...kept.kept);
    }
  }

  // 5. Cross-clause pass on structured data; no "missing" without a document search.
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
      // If the search itself failed we cannot claim the topic is missing.
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

  // 6. Coverage ledger.
  const ledgerInput: LedgerChunkInput[] = chunks.map((chunk) => {
    const prefix = `${runId}:a${chunk.index}`;
    const processed = clauseRun.tasks.some((t) => (t.id === prefix || t.id.startsWith(`${prefix}/`)) && t.status === 'done');
    const analysed = (clausesByChunk.get(chunk.index) ?? []).filter(isValidClauseItem).map((c) => str((c as Record<string, unknown>).clause_no));
    const verified = verifiedClauses.filter((c) => c.chunkIndex === chunk.index && c.verifiedItems > 0).map((c) => c.clauseNo);
    const itemsAnalysed = (clausesByChunk.get(chunk.index) ?? [])
      .filter(isValidClauseItem)
      .reduce<number>((n, c) => {
        const o = c as Record<string, unknown>;
        return n + ['obligations', 'dates', 'payments', 'risks'].reduce<number>((m, k) => m + arrOf(o[k]).length, 0);
      }, 0);
    return {
      chunkId: chunk.id,
      index: chunk.index,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      processed,
      detectedClauses: detectedClauses(chunk),
      analysedClauses: analysed,
      verifiedClauses: verified,
      itemsAnalysed,
      itemsVerified: verifiedClauses.filter((c) => c.chunkIndex === chunk.index).reduce((n, c) => n + c.verifiedItems, 0),
    };
  });
  const ledger = buildLedger(ledgerInput);
  ledger.totals.citedPages = [...new Set(verifiedClauses.flatMap((c) =>
    [...c.obligations, ...c.dates, ...c.payments, ...c.risks].map((i) => i.page),
  ))].sort((a, b) => a - b);

  // 10. Metrics over every task in this run (clause, section and overview tasks).
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

export async function restoreReportFromSupabase(
  supabase: SupabaseClient,
  docId: string,
): Promise<AnalysisReport | null> {
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
