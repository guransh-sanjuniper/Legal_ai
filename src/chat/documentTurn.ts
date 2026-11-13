import type { SupabaseClient } from '@supabase/supabase-js';
import type { DocumentRecord, HarnessDBHandle } from '../runner/db';
import type { SearchResult } from '../retrieval/client';
import { getDefinitions, definitionsContext } from '../retrieval/definitions';
import { buildAnalysisChunks, type AnalysisChunk } from '../analysis/analysisChunks';
import { loadPageMap, restoreReportFromSupabase } from '../analysis/runAnalysis';
import { ANALYSIS_MODEL, CONCURRENCY, FALLBACK_MODEL, PROMPT_RETRIEVAL_CHUNKS } from '../analysis/config';
import { promptOnReport } from '../analysis/promptOnReport';
import { promptPrompt } from '../analysis/promptPass';
import { buildReportModel, type Citation, type ReportModel } from '../analysis/reportModel';
import type { AnalysisReport } from '../analysis/types';
import { routeQuestion } from './route';
import { savedCitations, savedContent, promptResultContent } from './documentAnswer';
import { estimatePass, type PassEstimate } from './estimate';
import type { ChatMode } from './store';

// Document questions in chat. This is the only place chat calls analysis code: it reads the stored
// report, runs the existing prompt pass (promptOnReport) and tags the run it created. Analysis
// logic is not changed here.

export interface DocumentContext {
  doc: DocumentRecord;
  chunks: AnalysisChunk[];
  defsContext: string;
  report: AnalysisReport | null;
  model: ReportModel | null;
}

async function loadReport(db: HarnessDBHandle, supabase: SupabaseClient | null, docId: string): Promise<AnalysisReport | null> {
  const local = (await db.getAllFromIndex('analysis_reports', 'byDoc', docId)) as { report: AnalysisReport; savedAt: number }[];
  if (local.length) return [...local].sort((a, b) => b.savedAt - a.savedAt)[0].report;
  if (supabase) return restoreReportFromSupabase(supabase, docId);
  return null;
}

export async function loadDocumentContext(
  db: HarnessDBHandle,
  supabase: SupabaseClient | null,
  docId: string,
): Promise<DocumentContext> {
  const doc = (await db.get('documents', docId)) as DocumentRecord | undefined;
  if (!doc) throw new Error('This document is no longer on this device.');
  const chunks = buildAnalysisChunks(await loadPageMap(db, docId));
  const sheet = await getDefinitions(db, docId);
  const report = await loadReport(db, supabase, docId);
  return {
    doc,
    chunks,
    defsContext: sheet ? definitionsContext(sheet) : '',
    report,
    model: report ? buildReportModel(report) : null,
  };
}

// Pre-send estimates. Retrieval reads at most PROMPT_RETRIEVAL_CHUNKS sections, so its estimate
// uses the largest sections (an upper bound). The whole scan reads every section.
export function estimatesFor(ctx: DocumentContext): { retrieval: PassEstimate; whole: PassEstimate } {
  const promptText = promptPrompt(' ', ctx.report?.request?.reviewingFor ?? 'neutral');
  const sectionTexts = ctx.chunks.map((c) => c.pageMarkedText);
  const largest = [...sectionTexts].sort((a, b) => b.length - a.length).slice(0, PROMPT_RETRIEVAL_CHUNKS);
  const m = ctx.report?.metrics;
  const base = {
    promptText,
    defsContext: ctx.defsContext,
    concurrency: m?.concurrency ?? CONCURRENCY,
    p95DurationMs: m && m.p95DurationMs > 0 ? m.p95DurationMs : null,
  };
  return {
    retrieval: estimatePass({ ...base, sectionTexts: largest }),
    whole: estimatePass({ ...base, sectionTexts }),
  };
}

export interface DocumentTurnDeps {
  db: HarnessDBHandle;
  supabase: SupabaseClient;
  accessToken: string;
  refreshAccessToken: (force?: boolean) => Promise<string | null>;
  userId: string | null;
  functionsUrl: string;
  anonKey: string;
  search: (docId: string, query: string, k: number) => Promise<{ results: SearchResult[] }>;
  onStatus: (text: string) => void;
}

export interface DocumentTurnResult {
  content: string;
  mode: ChatMode;
  citations: Citation[];
  runId: string | null;
}

export async function answerFromDocument(
  question: string,
  ctx: DocumentContext,
  scanWhole: boolean,
  deps: DocumentTurnDeps,
): Promise<DocumentTurnResult> {
  const route = routeQuestion(question, ctx.model, scanWhole);
  if (route.mode === 'saved') {
    return {
      content: savedContent(route.rows, route.total),
      mode: 'saved',
      citations: savedCitations(route.rows),
      runId: null,
    };
  }

  const mode = route.mode;
  let searchFellBack = false;
  deps.onStatus(mode === 'whole' ? 'Scanning the whole document…' : 'Searching the document…');
  const res = await promptOnReport({
    db: deps.db,
    supabase: deps.supabase,
    accessToken: deps.accessToken,
    refreshAccessToken: deps.refreshAccessToken,
    userId: deps.userId,
    functionsUrl: deps.functionsUrl,
    anonKey: deps.anonKey,
    docId: ctx.doc.id,
    model: ANALYSIS_MODEL,
    fallbackModel: FALLBACK_MODEL,
    reasoning: { effort: 'minimal' },
    prompt: question,
    mode,
    reviewingFor: ctx.report?.request?.reviewingFor ?? 'neutral',
    search: async (q, k) => {
      try {
        const { results } = await deps.search(ctx.doc.id, q, k);
        if (results.length === 0) searchFellBack = true;
        return results;
      } catch (e) {
        searchFellBack = true;
        throw e;
      }
    },
    selectCount: PROMPT_RETRIEVAL_CHUNKS,
    onProgress: deps.onStatus,
  });

  // Chat-created runs are tagged so they can be told apart from analysis runs. A failed tag only
  // leaves the run untagged; the answer is still shown.
  await deps.supabase.from('runs').update({ source: 'chat' }).eq('id', res.runId);

  const text = promptResultContent(res.result, { searchFellBack });
  return { content: text.content, mode, citations: text.citations, runId: res.runId };
}
