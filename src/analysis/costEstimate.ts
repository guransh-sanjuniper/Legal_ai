import { estimateCost, OVERVIEW_TOKENS_PER_SENTENCE } from './config';
import { estimateInputTokens } from '../tasks/limits';
import { buildMissingPrompt, buildOverviewPrompt, CUSTOM_PROMPT_FOOTER, CUSTOM_PROMPT_HEADER, OVERVIEW_POINTS } from './prompts';
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
  // Risk validation (batched) and the Prompt Result synthesis.
  reviewCalls: number;
  synthesisCalls: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

const CUSTOM_OUTPUT_CAP = 1200;
// Rough upper bound for a risk-validation batch: ~80 input and ~200 output tokens per batch.
const REVIEW_INPUT_PER_BATCH = 1600;
const REVIEW_OUTPUT_PER_BATCH = 200;
const RISKS_PER_REVIEW_BATCH = 20;
const MISSING_OUTPUT_CAP = 1500;
const CLAUSES_PER_MISSING_GROUP = 60;

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

  let customCalls = 0;
  if (i.customPrompt.trim()) {
    const header = `${CUSTOM_PROMPT_HEADER}\nUSER REQUEST: ${i.customPrompt.trim()}\n${CUSTOM_PROMPT_FOOTER}`;
    const customIn = i.chunkTexts.map((t) => estimateInputTokens(`${header}\n${i.defsContext}\n${t}`));
    customCalls = i.chunkTexts.length;
    promptTokens += customIn.reduce((a, b) => a + b, 0);
    completionTokens += customCalls * Math.min(i.budget, CUSTOM_OUTPUT_CAP);
  }

  const synthesisCalls = customCalls > 0 ? 1 : 0;
  if (synthesisCalls) completionTokens += 600;

  const calls = clauseCalls + otherCalls + customCalls + reviewCalls + synthesisCalls;
  return {
    clauseCalls,
    customCalls,
    otherCalls,
    reviewCalls,
    synthesisCalls,
    calls,
    promptTokens,
    completionTokens,
    costUsd: estimateCost(promptTokens, completionTokens),
  };
}
