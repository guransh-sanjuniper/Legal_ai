// Model for the one-off instruction parse. A non-reasoning model: reasoning models can spend
// the whole output budget thinking and return no JSON, which is a visible failure here.
export const DRAFTER_PLAN_MODEL =
  (import.meta.env.VITE_DRAFTER_PLAN_MODEL as string) ||
  (import.meta.env.VITE_SEARCH_MODEL as string) ||
  'openai/gpt-4o-mini';

export const DRAFTER_PLAN_MAX_TOKENS = 1600;

// Outline calls: analysis-model chain, one call, large output budget for long documents.
export const DRAFTER_OUTLINE_MODEL =
  (import.meta.env.VITE_DRAFTER_OUTLINE_MODEL as string) ||
  (import.meta.env.VITE_ANALYSIS_MODEL as string) ||
  (import.meta.env.VITE_SEARCH_MODEL as string) ||
  'openai/gpt-4o-mini';

export const DRAFTER_OUTLINE_MAX_TOKENS = 6000;

// Writing calls: one per section, plain text, large enough for a long clause.
export const DRAFTER_WRITE_MODEL =
  (import.meta.env.VITE_DRAFTER_WRITE_MODEL as string) ||
  (import.meta.env.VITE_ANALYSIS_MODEL as string) ||
  (import.meta.env.VITE_SEARCH_MODEL as string) ||
  'openai/gpt-4o-mini';

export const DRAFTER_WRITE_MAX_TOKENS = 3000;
export const DRAFTER_CONCURRENCY = Math.max(
  1,
  Number((import.meta.env.VITE_DRAFTER_CONCURRENCY as string) || 3),
);
export const DRAFTER_RETRY_BASE_MS = 500;
export const DRAFTER_MAX_RETRIES = 3;

// Prices are per 1M tokens, in USD. Unset means the estimate shows no cost.
export const DRAFTER_PRICE_INPUT_PER_M = (() => {
  const raw = import.meta.env.VITE_PRICE_INPUT_PER_M as string | undefined;
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
})();

export const DRAFTER_PRICE_OUTPUT_PER_M = (() => {
  const raw = import.meta.env.VITE_PRICE_OUTPUT_PER_M as string | undefined;
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
})();
