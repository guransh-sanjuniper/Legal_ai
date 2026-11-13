import type { DocumentRecord } from '../runner/db';
import type { Task } from '../tasks/types';
import type { AnchorIndex } from './anchors';
import type { AnalysisChunk } from './analysisChunks';
import { buildPromptSynthesisPrompt, CUSTOM_PROMPT_FOOTER, CUSTOM_PROMPT_HEADER } from './prompts';
import { reviewingLine } from './request';
import type { ReviewingFor } from './types';
import { executeTasks, type ExecuteContext, type ExecuteResult, type TaskPlan } from './execute';
import { keepCitedSentences } from './rollup';
import { answersAboutQuestion, numericProblems } from './answerGuard';
import { normalizeQuote, verifyQuotedItems, type Located } from './verify';
import type { PromptAnswer, PromptResult } from './types';

export interface RawAnswer {
  text?: unknown;
  quote?: unknown;
  page?: unknown;
  clause_no?: unknown;
  part?: unknown;
  why?: unknown;
}

// An item needs its quote and a one-line reason that it answers the request. Without the reason
// the item is rejected, so a quote that only mentions a related term is never passed on.
export function isValidAnswerItem(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.text === 'string' &&
    typeof o.quote === 'string' &&
    typeof o.page === 'number' &&
    typeof o.why === 'string' &&
    o.why.trim().length > 0
  );
}

export function promptPrompt(request: string, reviewingFor: ReviewingFor = 'neutral'): string {
  return [CUSTOM_PROMPT_HEADER, reviewingLine(reviewingFor), `USER REQUEST: ${request}`, CUSTOM_PROMPT_FOOTER]
    .filter(Boolean)
    .join('\n');
}

// Merges verified answers from every chunk. The same page and quote from overlapping chunks is kept once.
// Direct answers come before supporting quotes; within each group the document order is kept.
export function mergeAnswers(located: Located<RawAnswer>[]): PromptAnswer[] {
  const seen = new Set<string>();
  const direct: PromptAnswer[] = [];
  const support: PromptAnswer[] = [];
  for (const v of located) {
    const text = typeof v.item.text === 'string' ? v.item.text.trim() : '';
    if (!text) continue;
    const key = `${v.item.page}|${normalizeQuote(v.item.quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const part: 'answer' | 'support' = v.item.part === 'support' ? 'support' : 'answer';
    const why = typeof v.item.why === 'string' && v.item.why.trim() ? v.item.why.trim() : undefined;
    const answer = { itemId: '', text, clause: v.item.clause, page: v.item.page, quote: v.item.quote, verified: true as const, part, why };
    (part === 'answer' ? direct : support).push(answer);
  }
  return [...direct, ...support].map((a, i) => ({ ...a, itemId: `P${i + 1}` }));
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
  reviewingFor?: ReviewingFor;
  maxTokens: number;
}

// Runs the custom prompt over every analysis chunk, then merges the verified answers.
// A failed chunk is retried once after a backoff. Chunks still failing are listed, not hidden.
export async function runPromptPass(
  args: PromptPassArgs,
): Promise<{ result: PromptResult; runs: ExecuteResult[] }> {
  const { ctx, runId, doc, chunks, index, defsContext, request, maxTokens } = args;
  const prompt = promptPrompt(request, args.reviewingFor);
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

// One synthesis over verified quotes/answers: the final answer in prose, citing their ids.
// Used by the inline (clause-call) mode and the post-report modes.
// Answers whose quote does not state the request's subject are removed before the model sees them;
// the model then writes "not clearly stated" when nothing is left. A sentence whose numbers or
// units do not match its cited quotes is removed after the model writes it. Both counts are
// returned so a caller can tell a guarded answer from one the model never wrote.
export const NOT_CLEAR_ANSWER = 'Not clearly stated in the document.';

// Before the model: keep only the answers whose quote states the request's subject.
export function prepareSynthesis(answers: PromptAnswer[], request: string): { relevant: PromptAnswer[]; dropped: number } {
  const relevant = answersAboutQuestion(answers, request);
  return { relevant, dropped: answers.length - relevant.length };
}

// After the model: keep sentences that cite only the relevant answers, and drop any whose numbers
// or units do not match the cited quotes. A failed call is left to the caller as an error; if the
// model wrote nothing usable otherwise, the answer is "not clearly stated".
export function finalizeSynthesis(
  relevant: PromptAnswer[],
  sentences: unknown[],
  failed: boolean,
): { answer: { text: string; cites: string[] }[]; numericDropped: number } {
  const ids = new Set(relevant.map((a) => a.itemId));
  const quoteById = new Map(relevant.map((a) => [a.itemId, a.quote]));
  const kept = keepCitedSentences(sentences as never[], ids).kept;
  let numericDropped = 0;
  const answer: { text: string; cites: string[] }[] = [];
  for (const k of kept) {
    const quotes = k.cites.map((id) => quoteById.get(id) ?? '');
    if (numericProblems(k.text, quotes).length > 0) {
      numericDropped++;
      continue;
    }
    answer.push({ text: k.text, cites: k.cites });
  }
  if (answer.length === 0 && !failed) answer.push({ text: NOT_CLEAR_ANSWER, cites: [] });
  return { answer, numericDropped };
}

export async function synthesiseAnswers(args: {
  ctx: ExecuteContext;
  runId: string;
  doc: DocumentRecord;
  prompt: string;
  answers: PromptAnswer[];
  maxTokens?: number;
}): Promise<{ answer: { text: string; cites: string[] }[]; runs: ExecuteResult[]; dropped: number; numericDropped: number }> {
  if (args.answers.length === 0) return { answer: [], runs: [], dropped: 0, numericDropped: 0 };
  const { relevant, dropped } = prepareSynthesis(args.answers, args.prompt);
  if (relevant.length === 0) {
    return { answer: [{ text: NOT_CLEAR_ANSWER, cites: [] }], runs: [], dropped, numericDropped: 0 };
  }

  const plan: TaskPlan = {
    suffix: 'ps',
    promptVersion: 'prompt-synthesis-v3',
    prompt: buildPromptSynthesisPrompt(),
    input: `USER REQUEST: ${args.prompt}\n\nVerified answers:\n${JSON.stringify(
      relevant.map((a) => ({ id: a.itemId, text: a.text, clause: a.clause, page: a.page, quote: a.quote, why: a.why ?? null })),
    )}`,
    maxTokens: args.maxTokens ?? 1200,
    validate: (x) => typeof x === 'object' && x !== null && typeof (x as { text?: unknown }).text === 'string',
  };
  const run = await executeTasks(args.ctx, args.runId, args.doc, [plan]);
  const sentences = run.collected.flatMap((c) => c.items);
  const failed = run.tasks.some((t) => t.status === 'failed');
  const out = finalizeSynthesis(relevant, sentences, failed);
  return { answer: out.answer, runs: [run], dropped, numericDropped: out.numericDropped };
}
