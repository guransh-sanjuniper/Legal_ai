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
