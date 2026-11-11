import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, DocumentRecord } from '../runner/db';
import { CUSTOM_PROMPT_FOOTER, CUSTOM_PROMPT_HEADER } from './prompts';
import { executeTasks, computeMetrics, createRun, type ExecuteContext, type TaskPlan } from './execute';
import { verifyQuote, normalizeQuote } from './verify';
import { loadPageMap } from './runAnalysis';
import type { AnalysisMetrics } from './types';

export interface CustomItem {
  text: string;
  page: number;
  quote: string;
  clause_no: string;
  itemId: string;
}

export interface CustomResult {
  runId: string;
  items: CustomItem[];
  dropped: number;
  metrics: AnalysisMetrics;
}

export function isValidCustomItem(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.text === 'string' && typeof o.quote === 'string' && typeof o.page === 'number';
}

export interface CustomOptions {
  db: HarnessDBHandle;
  supabase: SupabaseClient;
  accessToken: string;
  userId?: string | null;
  functionsUrl: string;
  anonKey: string;
  docId: string;
  prompt: string;
  model: string;
  fallbackModel: string | null;
  maxTokens?: number;
  onLog?: (line: string) => void;
}

// Applies a user prompt to every chunk, verifies quotes, then merges and dedupes.
export async function runCustomPrompt(opts: CustomOptions): Promise<CustomResult> {
  const { db, docId } = opts;
  const doc: DocumentRecord | undefined = await db.get('documents', docId);
  if (!doc?.prepFingerprint) throw new Error('document is not ready');
  const chunks = (await db.getAll('chunks', IDBKeyRange.bound(`${docId}:`, `${docId}:\uffff`))).sort((a, b) => a.index - b.index);
  const pages = await loadPageMap(db, docId);

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

  const prompt = `${CUSTOM_PROMPT_HEADER}\nUSER REQUEST: ${opts.prompt}\n${CUSTOM_PROMPT_FOOTER}`;
  const plans: TaskPlan[] = chunks.map((chunk, i) => {
    const parts: string[] = [];
    for (let p = chunk.pageStart; p <= chunk.pageEnd; p++) {
      const text = pages.get(p);
      if (text !== undefined) parts.push(`[page ${p}]\n${text}`);
    }
    return {
      suffix: `q${i}`,
      promptVersion: 'custom-prompt-v1',
      prompt,
      input: parts.join('\n'),
      maxTokens: opts.maxTokens ?? 1500,
      validate: isValidCustomItem,
    };
  });

  const run = await executeTasks(ctx, runId, doc, plans);
  const kept: CustomItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const c of run.collected) {
    for (const raw of c.items) {
      if (!isValidCustomItem(raw)) continue;
      const item = raw as { text: string; page: number; quote: string; clause_no?: string };
      if (!verifyQuote(item.quote, item.page, pages).ok) {
        dropped++;
        continue;
      }
      const key = normalizeQuote(item.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      kept.push({
        text: item.text.trim(),
        page: item.page,
        quote: item.quote.trim(),
        clause_no: item.clause_no ?? '',
        itemId: `${c.taskId}:${kept.length}`,
      });
    }
  }
  const metrics = await computeMetrics(db, run.tasks);
  await opts.supabase.from('runs').update({ status: 'complete', updated_at: new Date().toISOString() }).eq('id', runId);
  return { runId, items: kept, dropped, metrics };
}
