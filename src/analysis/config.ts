// Pricing is per 1,000,000 tokens, in USD. Override with VITE_PRICE_INPUT_PER_M /
// VITE_PRICE_OUTPUT_PER_M when the model changes.
export const PRICING = {
  inputPerM: Number((import.meta.env.VITE_PRICE_INPUT_PER_M as string) ?? '0.15'),
  outputPerM: Number((import.meta.env.VITE_PRICE_OUTPUT_PER_M as string) ?? '0.60'),
};

export const ANALYSIS_MODEL =
  (import.meta.env.VITE_ANALYSIS_MODEL as string) ||
  (import.meta.env.VITE_SEARCH_MODEL as string) ||
  (import.meta.env.VITE_MODEL as string) ||
  'openai/gpt-4o-mini';

export const FALLBACK_MODEL = (import.meta.env.VITE_FALLBACK_MODEL as string) || null;

export const ANALYSIS_TIMEOUT_MS = 110_000;
// Parallel model calls per run. Backoff after a rate limit or network error is shared.
export const CONCURRENCY = Math.max(1, Number((import.meta.env.VITE_CONCURRENCY as string) || 3));
export const INITIAL_MAX_TOKENS = 2600;
export const BUDGET_FACTOR = 1.5;
export const MIN_BUDGET_TOKENS = 600;
export const MAX_BUDGET_TOKENS = 6000;

// Cost of a set of calls, from the price config.
export function estimateCost(promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1_000_000) * PRICING.inputPerM + (completionTokens / 1_000_000) * PRICING.outputPerM;
}
