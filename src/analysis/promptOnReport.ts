import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, DocumentRecord } from '../runner/db';
import { buildAnchorIndex } from './anchors';
import { buildAnalysisChunks, type AnalysisChunk } from './analysisChunks';
import { loadPageMap } from './runAnalysis';
import { createRun, computeMetrics, type ExecuteContext } from './execute';
import { runPromptPass, synthesiseAnswers } from './promptPass';
import { answersAboutQuestion } from './answerGuard';
import { getDefinitions, definitionsContext } from '../retrieval/definitions';
import { PROMPT_RETRIEVAL_CHUNKS } from './config';
import type { AnalysisMetrics, PromptResult, ReviewingFor } from './types';

export interface PromptSearchHit {
  pageStart: number;
  pageEnd: number;
  fused: number;
}

// A prompt asked after a report already exists. Retrieval mode reads only the top relevant chunks;
// whole mode reads every chunk. Both then run one synthesis. The general analysis is not recomputed.

export interface PromptOnReportOptions {
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
  prompt: string;
  mode: 'retrieval' | 'whole';
  reviewingFor?: ReviewingFor;
  search: (query: string, k: number) => Promise<PromptSearchHit[]>;
  selectCount?: number;
  // Whole mode only: read these chunk indexes instead of every chunk. Unset reads every chunk.
  chunkIndexes?: number[];
  onProgress?: (msg: string) => void;
  onLog?: (line: string) => void;
  callModel?: (req: import('../tasks/types').CallRequest) => Promise<import('../tasks/types').CallResult>;
}

export interface PromptOnReportResult {
  result: PromptResult;
  runId: string;
  metrics: AnalysisMetrics;
  selectedChunks: number;
  totalChunks: number;
}

// Whole mode reads every chunk unless an index subset is given (the chat pre-filter). Order is kept.
export function wholeChunks(chunks: AnalysisChunk[], indexes?: number[]): AnalysisChunk[] {
  if (!indexes) return chunks;
  const wanted = new Set(indexes);
  return chunks.filter((c) => wanted.has(c.index));
}

// Chunks that a search hit touches, scored by the hit's fused score.
export function rankChunksForPrompt(chunks: AnalysisChunk[], hits: PromptSearchHit[]): { index: number; score: number }[] {
  const scores = new Map<number, number>();
  for (const hit of hits) {
    for (const c of chunks) {
      if (c.pageEnd < hit.pageStart || c.pageStart > hit.pageEnd) continue;
      scores.set(c.index, (scores.get(c.index) ?? 0) + hit.fused);
    }
  }
  return [...scores.entries()]
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

export async function promptOnReport(opts: PromptOnReportOptions): Promise<PromptOnReportResult> {
  const log = opts.onLog ?? (() => {});
  const progress = opts.onProgress ?? (() => {});
  const doc: DocumentRecord | undefined = await opts.db.get('documents', opts.docId);
  if (!doc || doc.status !== 'ready' || !doc.prepFingerprint) throw new Error('document is not ready');

  const pages = await loadPageMap(opts.db, opts.docId);
  const index = buildAnchorIndex(pages);
  const chunks = buildAnalysisChunks(pages);
  if (chunks.length === 0) throw new Error('no analysis chunks');

  let selected: AnalysisChunk[];
  if (opts.mode === 'whole') {
    selected = wholeChunks(chunks, opts.chunkIndexes);
    if (selected.length === 0) throw new Error('no chunks to read');
    progress(`whole-document scan over ${selected.length} chunks`);
  } else {
    const want = Math.max(1, opts.selectCount ?? PROMPT_RETRIEVAL_CHUNKS);
    let ranked: { index: number; score: number }[] = [];
    try {
      ranked = rankChunksForPrompt(chunks, await opts.search(opts.prompt, want * 2));
    } catch (e) {
      log(`retrieval search failed: ${String(e)}`);
    }
    // Fall back to the first chunks when search returns nothing, so the prompt still runs.
    const indexes = ranked.length > 0 ? ranked.slice(0, want).map((r) => r.index) : chunks.slice(0, want).map((c) => c.index);
    const byIndex = new Map(chunks.map((c) => [c.index, c]));
    selected = indexes.map((i) => byIndex.get(i)!).filter(Boolean);
    progress(`reading ${selected.length} of ${chunks.length} relevant chunks`);
  }

  const sheet = await getDefinitions(opts.db, opts.docId);
  const defsContext = sheet ? definitionsContext(sheet) : '';

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
    reasoning: opts.reasoning ?? null,
    timeoutMs: 110_000,
    onLog: log,
    callModel: opts.callModel,
  };
  const runId = await createRun(ctx, doc);

  const pass = await runPromptPass({
    ctx,
    runId,
    doc,
    chunks: selected,
    index,
    defsContext,
    request: opts.prompt,
    reviewingFor: opts.reviewingFor,
    maxTokens: 1200,
  });
  const synth = await synthesiseAnswers({ ctx, runId, doc, prompt: opts.prompt, answers: pass.result.answers });
  const failedCodes = [
    ...new Set(
      [...pass.runs, ...synth.runs].flatMap((r) => r.tasks).filter((t) => t.status === 'failed').map((t) => t.failureCode ?? 'failed'),
    ),
  ];
  const metrics = await computeMetrics(opts.db, await opts.db.getAllFromIndex('tasks', 'byRun', runId));
  await opts.supabase.from('runs').update({ status: 'complete', updated_at: new Date().toISOString() }).eq('id', runId);

  return {
    result: {
      prompt: opts.prompt,
      // Only quotes that state the request's subject are shown as support.
      answers: answersAboutQuestion(pass.result.answers, opts.prompt),
      answer: synth.answer,
      mode: opts.mode,
      selectedChunks: selected.length,
      chunksTotal: chunks.length,
      chunksDone: selected.length,
      failedChunks: pass.result.failedChunks,
      ...(failedCodes.length
        ? { error: `Answer generation failed (${failedCodes.join(', ')}). The verified quotes are listed below.` }
        : {}),
    },
    runId,
    metrics,
    selectedChunks: selected.length,
    totalChunks: chunks.length,
  };
}
