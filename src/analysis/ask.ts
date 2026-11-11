import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, DocumentRecord } from '../runner/db';
import { ASK_RETRIEVAL_PROMPT } from './prompts';
import { executeTasks, computeMetrics, createRun, type ExecuteContext, type TaskPlan } from './execute';
import { verifyQuotedItems } from './verify';
import { buildAnchorIndex } from './anchors';
import { loadPageMap, pageInput } from './runAnalysis';
import type { AnalysisMetrics } from './types';

export interface RetrievedChunk {
  chunkId: string;
  pageStart: number;
  pageEnd: number;
  clauses: string[];
  windowText: string;
  fused: number;
  vectorScore: number;
  keywordScore: number;
}

export interface AskCitation {
  text: string;
  page: number;
  quote: string;
  clause_no: string;
}

export interface AskResult {
  mode: 'retrieval';
  query: string;
  answer: string;
  citations: AskCitation[];
  chunks: RetrievedChunk[];
  notFound: boolean;
  runId: string | null;
  metrics: AnalysisMetrics | null;
}

export const NOT_FOUND_ANSWER = 'not found in this document';
export const UNVERIFIED_ANSWER = 'not found in this document (the model answer could not be verified against the stored text)';

export interface RetrievalAskOptions {
  db: HarnessDBHandle;
  supabase: SupabaseClient;
  accessToken: string;
  refreshAccessToken?: (force?: boolean) => Promise<string | null>;
  userId?: string | null;
  functionsUrl: string;
  anonKey: string;
  docId: string;
  query: string;
  model: string;
  fallbackModel: string | null;
  search: (query: string, k: number) => Promise<RetrievedChunk[]>;
  onLog?: (line: string) => void;
}

export function isValidAskItem(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.text === 'string' && typeof o.quote === 'string' && typeof o.page === 'number';
}

// Retrieval answer: hybrid search, then one proxy call over the retrieved windows.
// Below-cutoff search returns "not found" without calling the model at all.
export async function askRetrieval(opts: RetrievalAskOptions): Promise<AskResult> {
  const chunks = await opts.search(opts.query, 6);
  if (chunks.length === 0) {
    return {
      mode: 'retrieval',
      query: opts.query,
      answer: NOT_FOUND_ANSWER,
      citations: [],
      chunks,
      notFound: true,
      runId: null,
      metrics: null,
    };
  }

  const doc: DocumentRecord | undefined = await opts.db.get('documents', opts.docId);
  if (!doc?.prepFingerprint) throw new Error('document is not ready');
  const pages = await loadPageMap(opts.db, opts.docId);
  const index = buildAnchorIndex(pages);
  const lastPage = Math.max(...pages.keys());

  const ctx: ExecuteContext = {
    db: opts.db,
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

  const context = chunks
    .map((c, i) => `Excerpt W${i + 1} (pages ${c.pageStart}-${c.pageEnd}):\n${pageInput(pages, c.pageStart, c.pageEnd)}`)
    .join('\n\n');
  const plan: TaskPlan = {
    suffix: 'ask',
    promptVersion: 'ask-retrieval-v1',
    prompt: ASK_RETRIEVAL_PROMPT,
    input: `QUESTION: ${opts.query}\n\n${context}`,
    maxTokens: 900,
    validate: isValidAskItem,
  };

  const run = await executeTasks(ctx, runId, doc, [plan]);
  const citations: AskCitation[] = [];
  for (const c of run.collected) {
    for (const raw of c.items) {
      if (!isValidAskItem(raw)) continue;
      const item = raw as { text: string; page: number; quote: string; clause_no?: string };
      const check = verifyQuotedItems('citation', [{ quote: item.quote, page: item.page }], index, { start: 1, end: lastPage });
      if (check.verified.length === 0) continue;
      const v = check.verified[0].item;
      citations.push({ text: item.text.trim(), page: v.page, quote: v.quote, clause_no: v.clause });
    }
  }
  const metrics = await computeMetrics(opts.db, run.tasks);
  await opts.supabase.from('runs').update({ status: 'complete', updated_at: new Date().toISOString() }).eq('id', runId);

  if (citations.length === 0) {
    return {
      mode: 'retrieval',
      query: opts.query,
      answer: UNVERIFIED_ANSWER,
      citations: [],
      chunks,
      notFound: true,
      runId,
      metrics,
    };
  }
  return {
    mode: 'retrieval',
    query: opts.query,
    answer: citations.map((c) => c.text).join(' '),
    citations,
    chunks,
    notFound: false,
    runId,
    metrics,
  };
}
