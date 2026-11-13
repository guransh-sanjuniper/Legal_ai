import { estimateCost } from '../analysis/config';
import { estimateInputTokens } from '../tasks/limits';

// Upper bound for one prompt pass over sections, shown before the question is sent. Input is the
// real prompt text and section text; output assumes every call uses its full cap. The synthesis
// call is one more call, with an input allowance per section for the verified quotes.

export const PASS_OUTPUT_TOKENS = 1200;
const SYNTHESIS_OUTPUT_TOKENS = 1200;
const SYNTHESIS_INPUT_PER_SECTION = 150;

export interface PassEstimate {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  // Null when no completed run on this document has measured a call duration.
  minutes: number | null;
}

export interface PassEstimateInput {
  // Section texts that will be read (for retrieval, the largest sections: an upper bound).
  sectionTexts: string[];
  // The prompt header and reviewing line, plus the definitions sheet, sent with every section.
  promptText: string;
  defsContext: string;
  concurrency: number;
  // Measured p95 duration of one call on this document, if a run has completed.
  p95DurationMs: number | null;
}

export function estimatePass(i: PassEstimateInput): PassEstimate {
  const fixed = estimateInputTokens(`${i.promptText}\n${i.defsContext}`);
  const sectionTokens = i.sectionTexts.reduce((n, t) => n + estimateInputTokens(t), 0);
  const sections = i.sectionTexts.length;
  const calls = sections > 0 ? sections + 1 : 0;

  const promptTokens = sections * fixed + sectionTokens + (sections > 0 ? sections * SYNTHESIS_INPUT_PER_SECTION : 0);
  const completionTokens = sections * PASS_OUTPUT_TOKENS + (sections > 0 ? SYNTHESIS_OUTPUT_TOKENS : 0);

  const minutes =
    i.p95DurationMs === null || calls === 0
      ? null
      : Math.max(1, Math.ceil((Math.ceil(calls / Math.max(1, i.concurrency)) * i.p95DurationMs) / 60_000));

  return { calls, promptTokens, completionTokens, costUsd: estimateCost(promptTokens, completionTokens), minutes };
}

// Human line for the composer. The cost is shown to cents; a small cost reads "under $0.01".
export function describePass(label: string, e: PassEstimate): string {
  if (e.calls === 0) return `${label}: no sections to read.`;
  const cost = e.costUsd < 0.01 ? 'under $0.01' : `about $${e.costUsd.toFixed(2)}`;
  const time = e.minutes === null ? 'time unknown until an analysis run has finished on this document' : `about ${e.minutes} min`;
  const tokens = `${Math.round(e.promptTokens / 1000)}k input tokens`;
  return `${label}: ${e.calls} model calls, ${tokens}, ${cost}, ${time}.`;
}
