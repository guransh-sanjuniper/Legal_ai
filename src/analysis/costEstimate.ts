import { estimateCost, OVERVIEW_TOKENS_PER_SENTENCE } from './config';
import { estimateInputTokens } from '../tasks/limits';
import {
  buildMissingPrompt,
  buildOverviewPrompt,
  buildPromptSynthesisPromptDeep,
  CUSTOM_PROMPT_FOOTER,
  CUSTOM_PROMPT_HEADER,
  OVERVIEW_POINTS,
} from './prompts';
import { promptDepth } from './promptShape';
import { OVERVIEW_SENTENCES_PER_POINT } from './request';
import type { DetailLevel } from './types';

// Upper bound for one run, before it starts. Input comes from the local chunks and the real prompt
// text; output assumes every call uses its full token budget. The custom pass is added only when the field is filled.

export interface EstimateInput {
  clausePrompt: string;
  defsContext: string;
  chunkTexts: string[];
  clauseCount: number;
  summaryChars: number;
  budget: number;
  detail: DetailLevel;
  focus: string;
  customPrompt: string;
}

export interface RunEstimate {
  clauseCalls: number;
  customCalls: number;
  otherCalls: number;
  // Risk validation (batched) and the Prompt Result answer.
  reviewCalls: number;
  // One answer call per part of the custom prompt.
  synthesisCalls: number;
  // A part whose answer is cut off gets one retry at twice the budget.
  answerRetryCalls: number;
  // Extra section reads for a broad or list-type custom prompt.
  evidenceCalls: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

// Rough upper bound for one evidence read: the answer prompt, the definitions sheet and the chunk.
const CUSTOM_ANSWER_CAP = 1200;
// Rough upper bound for a risk-validation batch: ~80 input and ~200 output tokens per batch.
const REVIEW_INPUT_PER_BATCH = 1600;
const REVIEW_OUTPUT_PER_BATCH = 200;
const RISKS_PER_REVIEW_BATCH = 20;
const MISSING_OUTPUT_CAP = 1500;
const CLAUSES_PER_MISSING_GROUP = 60;
// Each clause call can return up to five short quotes for the custom prompt.
const CUSTOM_QUOTES_PER_CLAUSE = 5;
const CUSTOM_QUOTE_CHARS = 220;

export function estimateRun(i: EstimateInput): RunEstimate {
  const clauseIn = i.chunkTexts.map((t) => estimateInputTokens(`${i.clausePrompt}\n${i.defsContext}\n${t}`));
  const clauseCalls = i.chunkTexts.length;
  let promptTokens = clauseIn.reduce((a, b) => a + b, 0);
  let completionTokens = clauseCalls * i.budget;

  // Missing-protections groups and the overview: both read the clause summaries.
  const groups = i.clauseCount > 0 ? Math.ceil(i.clauseCount / CLAUSES_PER_MISSING_GROUP) : 0;
  const summaryTokens = Math.ceil(i.summaryChars / 4);
  const missingPromptTokens = estimateInputTokens(buildMissingPrompt({ focus: i.focus }));
  const defsTokens = estimateInputTokens(i.defsContext);
  promptTokens += groups * (missingPromptTokens + defsTokens) + summaryTokens;
  completionTokens += groups * MISSING_OUTPUT_CAP;

  let otherCalls = groups;
  if (i.clauseCount > 0) {
    otherCalls += 1;
    promptTokens += estimateInputTokens(buildOverviewPrompt(i.detail)) + defsTokens + summaryTokens;
    // Statutory Compliance is built in code, so the model writes every point but that one.
    const modelPoints = OVERVIEW_POINTS.length - 1;
    completionTokens += Math.min(3000, modelPoints * OVERVIEW_SENTENCES_PER_POINT[i.detail] * OVERVIEW_TOKENS_PER_SENTENCE);
  }

  // One review batch per 20 clauses (assumes at most one High/Medium risk per clause).
  const reviewCalls = Math.ceil(i.clauseCount / RISKS_PER_REVIEW_BATCH);
  promptTokens += reviewCalls * REVIEW_INPUT_PER_BATCH;
  completionTokens += reviewCalls * REVIEW_OUTPUT_PER_BATCH;

  // The inline prompt rides in the clause call: a short promptAnswer field, no extra calls.
  const ask = i.customPrompt.trim();
  let customCalls = 0;
  if (ask) {
    const header = `${CUSTOM_PROMPT_HEADER}\nUSER REQUEST: ${ask}\n${CUSTOM_PROMPT_FOOTER}`;
    const askTokens = estimateInputTokens(header) - estimateInputTokens(CUSTOM_PROMPT_HEADER + CUSTOM_PROMPT_FOOTER);
    promptTokens += clauseCalls * Math.max(0, askTokens);
    completionTokens += clauseCalls * CUSTOM_ANSWER_CAP;
  }

  // Deep Analysis prompt: coverage reads, one answer call per part, and up to one cut-off retry each.
  const depth = ask ? promptDepth(ask) : null;
  const synthesisCalls = depth ? depth.parts.length : 0;
  const answerRetryCalls = synthesisCalls;
  const evidenceCalls = depth ? depth.breadth : 0;
  if (depth && synthesisCalls > 0) {
    const answerPromptTokens = estimateInputTokens(buildPromptSynthesisPromptDeep()) + defsTokens;
    const evidenceTokens = Math.ceil((i.clauseCount * CUSTOM_QUOTES_PER_CLAUSE * CUSTOM_QUOTE_CHARS) / 4);
    promptTokens += synthesisCalls * (answerPromptTokens + evidenceTokens);
    completionTokens += synthesisCalls * depth.maxAnswerTokens;
    // Worst case for the single retry: twice the budget, never above the hard ceiling.
    completionTokens += answerRetryCalls * Math.min(6000, depth.maxAnswerTokens * 2);
  }
  if (depth && evidenceCalls > 0) {
    const header = `${CUSTOM_PROMPT_HEADER}\nUSER REQUEST: ${ask}\n${CUSTOM_PROMPT_FOOTER}`;
    const largest = [...i.chunkTexts].sort((a, b) => b.length - a.length).slice(0, evidenceCalls);
    promptTokens += largest.reduce((n, t) => n + estimateInputTokens(`${header}\n${i.defsContext}\n${t}`), 0);
    completionTokens += evidenceCalls * CUSTOM_ANSWER_CAP;
  }

  const calls = clauseCalls + otherCalls + customCalls + reviewCalls + synthesisCalls + answerRetryCalls + evidenceCalls;
  return {
    clauseCalls,
    customCalls,
    otherCalls,
    reviewCalls,
    synthesisCalls,
    answerRetryCalls,
    evidenceCalls,
    calls,
    promptTokens,
    completionTokens,
    costUsd: estimateCost(promptTokens, completionTokens),
  };
}
