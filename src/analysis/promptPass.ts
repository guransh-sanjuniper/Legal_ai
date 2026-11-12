import type { DocumentRecord } from '../runner/db';
import type { Task } from '../tasks/types';
import type { AnchorIndex } from './anchors';
import type { AnalysisChunk } from './analysisChunks';
import { CUSTOM_PROMPT_FOOTER, CUSTOM_PROMPT_HEADER } from './prompts';
import { executeTasks, type ExecuteContext, type ExecuteResult, type TaskPlan } from './execute';
import { normalizeQuote, verifyQuotedItems, type Located } from './verify';
import type { PromptAnswer, PromptResult } from './types';

export interface RawAnswer {
  text?: unknown;
  quote?: unknown;
  page?: unknown;
  clause_no?: unknown;
}

export function isValidAnswerItem(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.text === 'string' && typeof o.quote === 'string' && typeof o.page === 'number';
}

export function promptPrompt(request: string): string {
  return [CUSTOM_PROMPT_HEADER, `USER REQUEST: ${request}`, CUSTOM_PROMPT_FOOTER].join('\n');
}

// Merges verified answers from every chunk. The same page and quote from overlapping chunks is kept once.
export function mergeAnswers(located: Located<RawAnswer>[]): PromptAnswer[] {
  const seen = new Set<string>();
  const out: PromptAnswer[] = [];
  for (const v of located) {
    const text = typeof v.item.text === 'string' ? v.item.text.trim() : '';
    if (!text) continue;
    const key = `${v.item.page}|${normalizeQuote(v.item.quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      itemId: `P${out.length + 1}`,
      text,
      clause: v.item.clause,
      page: v.item.page,
      quote: v.item.quote,
      verified: true,
    });
  }
  return out;
}

const chunkIndexOf = (taskId: string): number | null => {
  const suffix = taskId.slice(taskId.lastIndexOf(':') + 1).split('/')[0];
  const m = /^cx?(\d+)$/.exec(suffix);
  return m ? Number(m[1]) : null;
};

export interface PromptPassArgs {
  ctx: ExecuteContext;
  runId: string;
  doc: DocumentRecord;
  chunks: AnalysisChunk[];
  index: AnchorIndex;
  defsContext: string;
  request: string;
  maxTokens: number;
}

// Runs the custom prompt over every analysis chunk, then merges the verified answers.
// A failed chunk is retried once after a backoff. Chunks still failing are listed, not hidden.
export async function runPromptPass(
  args: PromptPassArgs,
): Promise<{ result: PromptResult; runs: ExecuteResult[] }> {
  const { ctx, runId, doc, chunks, index, defsContext, request, maxTokens } = args;
  const prompt = promptPrompt(request);
  const plan = (chunk: AnalysisChunk, suffix: string, delayMs?: number): TaskPlan => ({
    suffix,
    promptVersion: 'custom-prompt-v1',
    prompt,
    input: `${defsContext}\n\n${chunk.pageMarkedText}`,
    maxTokens,
    delayMs,
    validate: isValidAnswerItem,
  });

  const first = await executeTasks(ctx, runId, doc, chunks.map((c) => plan(c, `c${c.index}`)));
  const doneOnFirst = new Set(first.tasks.filter((t) => t.status === 'done').map((t) => chunkIndexOf(t.id)));
  const retryChunks = chunks.filter((c) => !doneOnFirst.has(c.index));
  const retry = retryChunks.length
    ? await executeTasks(ctx, runId, doc, retryChunks.map((c) => plan(c, `cx${c.index}`, 5000)))
    : null;

  const allTasks: Task[] = [...first.tasks, ...(retry?.tasks ?? [])];
  const doneIndexes = new Set<number>();
  for (const t of allTasks) {
    const idx = chunkIndexOf(t.id);
    if (idx !== null && t.status === 'done') doneIndexes.add(idx);
  }

  const itemsByChunk = new Map<number, unknown[]>();
  for (const run of [first, retry]) {
    if (!run) continue;
    for (const c of run.collected) {
      const idx = chunkIndexOf(c.taskId);
      if (idx === null) continue;
      itemsByChunk.set(idx, [...(itemsByChunk.get(idx) ?? []), ...c.items]);
    }
  }

  const located: Located<RawAnswer>[] = [];
  for (const chunk of chunks) {
    const items = (itemsByChunk.get(chunk.index) ?? []).filter(isValidAnswerItem) as RawAnswer[];
    const v = verifyQuotedItems<RawAnswer>('answer', items, index, { start: chunk.pageStart, end: chunk.pageEnd });
    located.push(...v.verified);
  }

  const failedChunks = chunks
    .filter((c) => !doneIndexes.has(c.index))
    .map((c) => {
      const latest = allTasks
        .filter((t) => chunkIndexOf(t.id) === c.index)
        .sort((a, b) => b.attemptNo - a.attemptNo)[0];
      return {
        chunkIndex: c.index,
        pages: [c.pageStart, c.pageEnd] as [number, number],
        failureCode: latest?.failureCode ?? null,
        message: latest?.failureMessage ?? (latest ? null : 'not run'),
      };
    });

  return {
    result: {
      prompt: args.request,
      answers: mergeAnswers(located),
      chunksTotal: chunks.length,
      chunksDone: doneIndexes.size,
      failedChunks,
    },
    runs: retry ? [first, retry] : [first],
  };
}
