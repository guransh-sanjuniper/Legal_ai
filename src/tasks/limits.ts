// Model input limits. Keep a safety margin for the system prompt, tokenizer differences and the
// output budget. A model missing here uses the conservative default.
export const DEFAULT_CONTEXT_LIMIT = 128_000;
export const SAFETY_MARGIN = 0.9;

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'openai/gpt-4o-mini': 128_000,
  'deepseek/deepseek-v4.1-flash': 128_000,
  'mistralai/mistral-small-24b-instruct-2501': 128_000,
};

export function contextLimitFor(model: string): number {
  return MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT;
}

// The input budget is the context limit after the safety margin, minus the requested output.
export function inputLimitFor(model: string, maxTokens: number): number {
  const usable = Math.floor(contextLimitFor(model) * SAFETY_MARGIN);
  return Math.max(1000, usable - Math.max(0, Math.floor(maxTokens)));
}

export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
