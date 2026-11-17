import type { DocumentRecord } from '../runner/db';
import { rawKey } from '../runner/db';
import type { Task } from '../tasks/types';
import { ACTIVE_STATUSES } from '../tasks/types';
import { makeTask } from '../tasks/make';
import { parseItems } from '../tasks/parse';
import { taskFingerprint } from '../tasks/fingerprint';
import { runTask } from '../runner/runTask';
import type { AnchorIndex } from './anchors';
import type { AnalysisChunk } from './analysisChunks';
import {
  buildPromptSynthesisPrompt,
  buildPromptSynthesisPromptDeep,
  CUSTOM_PROMPT_FOOTER,
  CUSTOM_PROMPT_HEADER,
  PROMPT_SYNTHESIS_RETRY_LINE,
  PROMPT_SYNTHESIS_VERSION,
  PROMPT_SYNTHESIS_VERSION_DEEP,
} from './prompts';
import { reviewingLine } from './request';
import type { ReviewingFor } from './types';
import { executeTasks, makeRunConfig, type ExecuteContext, type ExecuteResult, type TaskPlan } from './execute';
import { keepCitedSentences } from './rollup';
import { answersAboutQuestion, numericProblems } from './answerGuard';
import {
  buildRelevanceInput,
  buildRelevancePrompt,
  isValidRelevanceVerdict,
  judgeRejectedAnswers,
  RELEVANCE_MAX_TOKENS,
  RELEVANCE_PROMPT_VERSION,
} from './answerRelevance';
import { normalizeQuote, verifyQuotedItems, type Located } from './verify';
import { NOT_CLEAR_ANSWER, type AnswerRelevanceStats, type PromptAnswer, type PromptResult, type PromptResultPart } from './types';
import { partForQuote, stripAnswerIds, type PromptPartRef } from './promptShape';
import { DEEP_PROMPT_MAX_ANSWER_TOKENS } from './config';

export { NOT_CLEAR_ANSWER };

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
    promptVersion: 'custom-prompt-v2',
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

// Second chance for what the deterministic guard rejected. Quotes it accepts are kept without a model
// call. Only the rejected ones are judged, in batches; a "yes" keeps the quote with the model's reason
// as its "why". Original order is kept, and item ids are not renumbered.
export async function checkRelevance(args: {
  answers: PromptAnswer[];
  request: string;
  ask: (batches: PromptAnswer[][]) => Promise<unknown[]>;
}): Promise<{ relevant: PromptAnswer[]; dropped: number; relevance: AnswerRelevanceStats }> {
  // Matched by object, not id: a quote and its support can share an id in a fixture or a merged list.
  const { relevant: passing } = prepareSynthesis(args.answers, args.request);
  const passSet = new Set(passing);
  const rejected = args.answers.filter((a) => !passSet.has(a));
  const rejectedSet = new Set(rejected);
  const judged = await judgeRejectedAnswers({ rejected, ask: args.ask });
  const relevant = args.answers
    .filter((a) => passSet.has(a) || (rejectedSet.has(a) && judged.approved.has(a.itemId)))
    .map((a) => {
      const reason = judged.approved.get(a.itemId);
      return reason ? { ...a, why: reason } : a;
    });
  return { relevant, dropped: args.answers.length - relevant.length, relevance: judged.stats };
}

// Retry only: the synthesis task goes back to queued with the current template. Called after the
// relevance pass, because a queued synthesis task would otherwise run during it.
async function requeueSynthesis(ctx: ExecuteContext, runId: string): Promise<void> {
  const ps = await ctx.db.get('tasks', `${runId}:ps`);
  if (!ps) return;
  await ctx.db.put('tasks', {
    ...ps,
    status: 'queued',
    prompt: buildPromptSynthesisPrompt(),
    promptVersion: PROMPT_SYNTHESIS_VERSION,
    failureCode: null,
    failureMessage: null,
    nextAt: 0,
    updatedAt: Date.now(),
  });
}

// ---------- Deep Analysis Prompt Result (opt-in through opts) ----------

// A request is answered one part per call. Only the Deep Analysis call site sets this; every other
// caller (chat, the post-report prompt) leaves it out and gets the single default answer unchanged.
export interface PromptResultOptions {
  parts: PromptPartRef[];
  maxAnswerTokens: number;
  // True on the deep path: v5 prompt, style field, per-part answers, truncation retry.
  structured: boolean;
  readSections?: number;
  moreSections?: number;
}

interface SynthesisItem {
  text: string;
  cites: string[];
  style?: 'paragraph' | 'bullet';
}

const isSynthesisItem = (x: unknown): boolean => {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.text === 'string' && Array.isArray(o.cites) && o.cites.every((c) => typeof c === 'string');
};

const sleep = async (ms: number): Promise<void> => {
  if (ms > 0) await new Promise<void>((r) => setTimeout(r, ms));
};

interface DeepPlan {
  prompt: string;
  promptVersion: string;
  input: string;
  maxTokens: number;
}

// Creates the synthesis task, or refreshes it in place on a retry. Unlike the default path this
// task never splits: a split would answer half the evidence with the same instruction.
async function ensureDeepTask(
  ctx: ExecuteContext,
  doc: DocumentRecord,
  runId: string,
  suffix: string,
  plan: DeepPlan,
  force: boolean,
): Promise<Task> {
  const id = `${runId}:${suffix}`;
  const existing = await ctx.db.get('tasks', id);
  if (existing && !force) return existing;
  if (!existing) {
    const task = await makeTask(
      {
        id,
        runId,
        parentId: null,
        depth: 0,
        docHash: doc.hash,
        prepFingerprint: doc.prepFingerprint!,
        promptVersion: plan.promptVersion,
        prompt: plan.prompt,
        input: plan.input,
        maxTokens: plan.maxTokens,
      },
      Date.now(),
    );
    await ctx.db.put('tasks', task);
    return task;
  }
  const fingerprint = await taskFingerprint({
    docHash: existing.docHash,
    prepFingerprint: existing.prepFingerprint,
    promptVersion: plan.promptVersion,
    prompt: plan.prompt,
    input: plan.input,
  });
  const next: Task = {
    ...existing,
    status: 'queued',
    prompt: plan.prompt,
    promptVersion: plan.promptVersion,
    input: plan.input,
    maxTokens: plan.maxTokens,
    fingerprint,
    failureCode: null,
    failureMessage: null,
    nextAt: 0,
    updatedAt: Date.now(),
  };
  await ctx.db.put('tasks', next);
  return next;
}

// Runs one synthesis task to a settled state. Retryable failures wait out their own backoff, like a
// run worker would; a cut-off answer is left failed with code "length" for the caller's one retry.
async function runDeepTask(ctx: ExecuteContext, task: Task): Promise<Task> {
  const cfg = { ...makeRunConfig(ctx), maxSplitDepth: 0, reasoning: null, validateItem: isSynthesisItem };
  let current = task;
  for (let round = 0; round < 10; round++) {
    if (!ACTIVE_STATUSES.includes(current.status)) return current;
    await sleep((current.nextAt ?? 0) - Date.now());
    await runTask(ctx.db, current, cfg);
    const fresh = await ctx.db.get('tasks', current.id);
    if (!fresh) return current;
    current = fresh;
  }
  return current;
}

async function rawTextOf(ctx: ExecuteContext, task: Task): Promise<string | null> {
  if (!task.attemptId) return null;
  const raw = await ctx.db.get('raw_responses', rawKey(task.id, task.attemptId));
  return raw?.text ?? null;
}

function deepInput(partText: string, evidence: PromptAnswer[], coaching: boolean): string {
  const answers = JSON.stringify(
    evidence.map((a) => ({ id: a.itemId, text: a.text, clause: a.clause, page: a.page, quote: a.quote, why: a.why ?? null })),
  );
  const coverage = `COVERAGE: built from ${evidence.length} verified quote${
    evidence.length === 1 ? '' : 's'
  }. The evidence may not cover the whole document. Do not call the answer complete.`;
  return [`USER REQUEST: ${partText}\n\nVerified answers:\n${answers}`, coverage, coaching ? PROMPT_SYNTHESIS_RETRY_LINE : '']
    .filter(Boolean)
    .join('\n\n');
}

function asExecuteResult(runId: string, task: Task | null): ExecuteResult {
  const tasks = task ? [task] : [];
  return {
    runId,
    collected: [],
    rejected: [],
    rawItems: 0,
    tasks,
    failed: tasks.filter((t) => t.status === 'failed').length,
    aborted: false,
    rateLimitEvents: tasks.filter((t) => t.failureCode === 'http_429').length,
    rateLimitWaitMs: 0,
    concurrency: 1,
    pausedReason: null,
    pausedRetryAfterMs: 0,
  };
}

// One part of the answer. A cut-off answer gets exactly one retry at twice the budget (never above
// the hard ceiling). If it is cut off again the part stays truncated and whatever complete cited
// elements were returned are kept; an unparseable reply keeps none and the verified quotes stand in.
async function runDeepPart(args: {
  ctx: ExecuteContext;
  doc: DocumentRecord;
  runId: string;
  suffix: string;
  part: PromptPartRef;
  evidence: PromptAnswer[];
  baseTokens: number;
  retry: boolean;
}): Promise<{
  sentences: (SynthesisItem & { style: 'paragraph' | 'bullet' })[];
  truncated: boolean;
  failed: boolean;
  failureCode: string | null;
  task: Task | null;
  numericDropped: number;
}> {
  const { ctx, doc, runId, suffix, part, evidence } = args;
  const ids = new Set(evidence.map((a) => a.itemId));
  const prompt = buildPromptSynthesisPromptDeep();

  const parse = (text: string | null): SynthesisItem[] => {
    if (!text) return [];
    const parsed = parseItems(text, isSynthesisItem);
    if ('error' in parsed) return [];
    return (parsed.items as SynthesisItem[])
      .map((item) => ({ ...item, text: stripAnswerIds(item.text, ids) }))
      .filter((item) => item.text.trim().length > 0);
  };

  let plan: DeepPlan = {
    prompt,
    promptVersion: PROMPT_SYNTHESIS_VERSION_DEEP,
    input: deepInput(part.text, evidence, false),
    maxTokens: Math.max(1, args.baseTokens),
  };
  let task = await ensureDeepTask(ctx, doc, runId, suffix, plan, args.retry);
  task = await runDeepTask(ctx, task);
  let items = parse(await rawTextOf(ctx, task));
  let truncated = task.status === 'failed' && task.failureCode === 'length';

  if (truncated) {
    const doubled = Math.min(DEEP_PROMPT_MAX_ANSWER_TOKENS, plan.maxTokens * 2);
    ctx.onLog?.(`prompt part ${suffix}: cut off, retrying at ${doubled} tokens with no evidence split`);
    plan = { ...plan, input: deepInput(part.text, evidence, true), maxTokens: doubled };
    task = await ensureDeepTask(ctx, doc, runId, suffix, plan, true);
    task = await runDeepTask(ctx, task);
    items = parse(await rawTextOf(ctx, task));
    truncated = task.status === 'failed' && task.failureCode === 'length';
  }

  const failed = task.status !== 'done';
  const out = finalizeSynthesis(evidence, items, failed);
  const styleByText = new Map<string, 'paragraph' | 'bullet'>();
  for (const item of items) styleByText.set(item.text.trim(), item.style === 'bullet' ? 'bullet' : 'paragraph');
  return {
    sentences: out.answer.map((s) => ({ ...s, style: styleByText.get(s.text.trim()) ?? 'paragraph' })),
    truncated,
    failed,
    failureCode: task.failureCode ?? null,
    task,
    numericDropped: out.numericDropped,
  };
}

// Per-part relevance. Each part keeps only quotes whose text carries the part's concepts; quotes
// rejected by every part get the same one batched second-chance check, judged with the part they
// most likely belong to. Fail closed: a missing verdict leaves the quote out.
export async function checkRelevanceByPart(args: {
  answers: PromptAnswer[];
  parts: PromptPartRef[];
  ask: (partIndex: number, batches: PromptAnswer[][]) => Promise<unknown[]>;
}): Promise<{ partAnswers: PromptAnswer[][]; relevant: PromptAnswer[]; dropped: number; relevance: AnswerRelevanceStats }> {
  const passByPart = args.parts.map((part) => answersAboutQuestion(args.answers, part.text));
  const passSet = new Set(passByPart.flat());
  const groups = new Map<number, PromptAnswer[]>();
  for (const a of args.answers.filter((item) => !passSet.has(item))) {
    const i = partForQuote(a.quote, args.parts);
    groups.set(i, [...(groups.get(i) ?? []), a]);
  }
  const merged: AnswerRelevanceStats = { checked: 0, kept: 0, rejected: 0, calls: 0, decisions: [] };
  const approvedByPart = new Map<number, Map<string, string>>();
  let error: string | undefined;
  for (const [i, items] of groups) {
    const judged = await judgeRejectedAnswers({ rejected: items, ask: (batches) => args.ask(i, batches) });
    merged.checked += judged.stats.checked;
    merged.kept += judged.stats.kept;
    merged.rejected += judged.stats.rejected;
    merged.calls += judged.stats.calls;
    merged.decisions.push(...judged.stats.decisions);
    if (judged.stats.error && !error) error = judged.stats.error;
    approvedByPart.set(i, judged.approved);
  }
  if (error) merged.error = error;
  const partAnswers = args.parts.map((_, i) =>
    args.answers
      .filter((a) => passByPart[i].includes(a) || approvedByPart.get(i)?.has(a.itemId))
      .map((a) => {
        const reason = approvedByPart.get(i)?.get(a.itemId);
        return reason ? { ...a, why: reason } : a;
      }),
  );
  const byId = new Map<string, PromptAnswer>();
  for (const list of partAnswers) for (const a of list) if (!byId.has(a.itemId)) byId.set(a.itemId, a);
  const relevant = args.answers.map((a) => byId.get(a.itemId)).filter((a): a is PromptAnswer => Boolean(a));
  return { partAnswers, relevant, dropped: args.answers.length - relevant.length, relevance: merged };
}

async function synthesiseDeepAnswers(
  args: {
    ctx: ExecuteContext;
    runId: string;
    doc: DocumentRecord;
    prompt: string;
    answers: PromptAnswer[];
    retry?: boolean;
  },
  opts: PromptResultOptions,
): Promise<{
  answer: { text: string; cites: string[] }[];
  parts: PromptResultPart[];
  truncated: boolean;
  runs: ExecuteResult[];
  dropped: number;
  numericDropped: number;
  answers: PromptAnswer[];
  relevance?: AnswerRelevanceStats;
}> {
  const parts = opts.parts.length > 0 ? opts.parts : [{ heading: null, text: args.prompt }];
  const relevanceRuns: ExecuteResult[] = [];
  const checked = await checkRelevanceByPart({
    answers: args.answers,
    parts,
    ask: async (partIndex, batches) => {
      const tag = partIndex === 0 ? '' : `p${partIndex + 1}`;
      const run = await executeTasks(
        args.ctx,
        args.runId,
        args.doc,
        batches.map((b, i) => ({
          suffix: `rj${tag}${i === 0 ? '' : `b${i + 1}`}`,
          promptVersion: RELEVANCE_PROMPT_VERSION,
          prompt: buildRelevancePrompt(),
          input: buildRelevanceInput(parts[partIndex].text, b),
          maxTokens: RELEVANCE_MAX_TOKENS,
          validate: isValidRelevanceVerdict,
        })),
      );
      relevanceRuns.push(run);
      return run.collected.flatMap((c) => c.items);
    },
  });
  const { relevance } = checked;
  if (relevance.checked > 0) {
    args.ctx.onLog?.(
      `answer relevance: ${relevance.checked} rejected quote(s) checked in ${relevance.calls} call(s); kept ${relevance.kept}, rejected ${relevance.rejected}${relevance.error ? `; check failed: ${relevance.error}` : ''}`,
    );
  }

  if (checked.relevant.length === 0) {
    return {
      answer: [{ text: NOT_CLEAR_ANSWER, cites: [] }],
      parts: parts.map((part) => ({ heading: part.heading, sentences: [], notStated: true, truncated: false, error: null })),
      truncated: false,
      runs: relevanceRuns,
      dropped: checked.dropped,
      numericDropped: 0,
      answers: [],
      relevance,
    };
  }

  const runs = [...relevanceRuns];
  const outParts: PromptResultPart[] = [];
  const flat: { text: string; cites: string[] }[] = [];
  let numericDropped = 0;
  let truncated = false;
  for (let i = 0; i < parts.length; i++) {
    const evidence = checked.partAnswers[i];
    if (evidence.length === 0) {
      outParts.push({ heading: parts[i].heading, sentences: [], notStated: true, truncated: false, error: null });
      flat.push({ text: NOT_CLEAR_ANSWER, cites: [] });
      continue;
    }
    const outcome = await runDeepPart({
      ctx: args.ctx,
      doc: args.doc,
      runId: args.runId,
      suffix: i === 0 ? 'ps' : `ps${i + 1}`,
      part: parts[i],
      evidence,
      baseTokens: opts.maxAnswerTokens,
      retry: args.retry ?? false,
    });
    runs.push(asExecuteResult(args.runId, outcome.task));
    numericDropped += outcome.numericDropped;
    truncated = truncated || outcome.truncated;
    const error = outcome.failed
      ? outcome.truncated && outcome.sentences.length === 0
        ? 'This part was cut off at the output limit before it could be completed.'
        : `This part could not be written up (${outcome.failureCode ?? 'failed'}). Use Retry failed only to run it again.`
      : null;
    outParts.push({
      heading: parts[i].heading,
      sentences: outcome.sentences,
      notStated: outcome.sentences.length === 0 && !outcome.failed,
      truncated: outcome.truncated,
      error,
    });
    for (const s of outcome.sentences) flat.push({ text: s.text, cites: s.cites });
  }
  return {
    answer: flat,
    parts: outParts,
    truncated,
    runs,
    dropped: checked.dropped,
    numericDropped,
    answers: checked.relevant,
    relevance,
  };
}

export async function synthesiseAnswers(args: {
  ctx: ExecuteContext;
  runId: string;
  doc: DocumentRecord;
  prompt: string;
  answers: PromptAnswer[];
  maxTokens?: number;
  retry?: boolean;
  // Deep Analysis only. Absent (chat, post-report prompts) keeps today's single-answer path.
  opts?: PromptResultOptions;
}): Promise<{
  answer: { text: string; cites: string[] }[];
  runs: ExecuteResult[];
  dropped: number;
  numericDropped: number;
  // The quotes the synthesis used (deterministic passes plus second-chance keeps).
  answers: PromptAnswer[];
  relevance?: AnswerRelevanceStats;
  // Deep path only.
  parts?: PromptResultPart[];
  truncated?: boolean;
}> {
  if (args.answers.length === 0) {
    if (args.retry) await requeueSynthesis(args.ctx, args.runId);
    return { answer: [], runs: [], dropped: 0, numericDropped: 0, answers: [] };
  }
  if (args.opts?.structured) return synthesiseDeepAnswers(args, args.opts);

  const relevanceRuns: ExecuteResult[] = [];
  const checked = await checkRelevance({
    answers: args.answers,
    request: args.prompt,
    ask: async (batches) => {
      const run = await executeTasks(
        args.ctx,
        args.runId,
        args.doc,
        batches.map((b, i) => ({
          suffix: i === 0 ? 'rj' : `rj${i + 1}`,
          promptVersion: RELEVANCE_PROMPT_VERSION,
          prompt: buildRelevancePrompt(),
          input: buildRelevanceInput(args.prompt, b),
          maxTokens: RELEVANCE_MAX_TOKENS,
          validate: isValidRelevanceVerdict,
        })),
      );
      relevanceRuns.push(run);
      return run.collected.flatMap((c) => c.items);
    },
  });
  const { relevance } = checked;
  if (relevance.checked > 0) {
    args.ctx.onLog?.(
      `answer relevance: ${relevance.checked} rejected quote(s) checked in ${relevance.calls} call(s); kept ${relevance.kept}, rejected ${relevance.rejected}${relevance.error ? `; check failed: ${relevance.error}` : ''}`,
    );
  }
  const relevant = checked.relevant;
  if (args.retry) await requeueSynthesis(args.ctx, args.runId);
  if (relevant.length === 0) {
    return {
      answer: [{ text: NOT_CLEAR_ANSWER, cites: [] }],
      runs: relevanceRuns,
      dropped: checked.dropped,
      numericDropped: 0,
      answers: relevant,
      relevance,
    };
  }

  const plan: TaskPlan = {
    suffix: 'ps',
    promptVersion: PROMPT_SYNTHESIS_VERSION,
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
  return {
    answer: out.answer,
    runs: [...relevanceRuns, run],
    dropped: checked.dropped,
    numericDropped: out.numericDropped,
    answers: relevant,
    relevance,
  };
}
