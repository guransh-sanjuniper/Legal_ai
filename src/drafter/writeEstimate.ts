import { DRAFTER_PRICE_INPUT_PER_M, DRAFTER_PRICE_OUTPUT_PER_M } from './config';
import { chosenCandidate } from './resolveRef';
import type { DraftRecord } from './types';
import { verbatimSourceFor } from './write';

// Rough pre-run estimate. Shown before Start and labelled as an estimate.

export interface WriteEstimate {
  items: number;
  modelItems: number;
  verbatimItems: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  seconds: number;
}

export const ESTIMATE_INPUT_BASE_TOKENS = 900;
export const ESTIMATE_OUTPUT_PER_ITEM = 400;
export const ESTIMATE_SECONDS_PER_CALL = 18;

export function estimateWriting(
  draft: DraftRecord,
  opts: { concurrency?: number; secondsPerCall?: number } = {},
): WriteEstimate {
  const items = draft.outline?.items ?? [];
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 3));
  const secondsPerCall = opts.secondsPerCall ?? ESTIMATE_SECONDS_PER_CALL;
  const particulars = draft.particulars?.length ?? 0;

  let modelItems = 0;
  let verbatimItems = 0;
  let inputTokens = 0;

  for (const item of items) {
    if (verbatimSourceFor(item, draft)) {
      verbatimItems++;
      continue;
    }
    modelItems++;
    const sourceChars = item.bindingIds.reduce((sum, bindingId) => {
      const resolution = draft.sourceText?.resolutions.find((entry) => entry.bindingId === bindingId);
      return sum + (resolution ? (chosenCandidate(resolution)?.text.length ?? 0) : 0);
    }, 0);
    inputTokens += ESTIMATE_INPUT_BASE_TOKENS + Math.ceil(sourceChars / 4) + particulars * 20;
  }

  const outputTokens = modelItems * ESTIMATE_OUTPUT_PER_ITEM;
  const costUsd =
    DRAFTER_PRICE_INPUT_PER_M === null || DRAFTER_PRICE_OUTPUT_PER_M === null
      ? null
      : (inputTokens / 1_000_000) * DRAFTER_PRICE_INPUT_PER_M +
        (outputTokens / 1_000_000) * DRAFTER_PRICE_OUTPUT_PER_M;

  return {
    items: items.length,
    modelItems,
    verbatimItems,
    inputTokens,
    outputTokens,
    costUsd,
    seconds: Math.ceil(modelItems / concurrency) * secondsPerCall,
  };
}
