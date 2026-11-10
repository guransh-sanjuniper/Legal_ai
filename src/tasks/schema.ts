export const PROMPT_VERSION = 'clause-v1';

export const CLAUSE_PROMPT =
  'You extract clauses from a legal contract excerpt. Return ONLY a JSON array. ' +
  'Each item is an object: {"clause_no": string, "summary": string, "quote": string}. ' +
  'The quote must be copied exactly from the excerpt. No prose outside the JSON.';

export function validateClauseItem(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.clause_no === 'string' && typeof o.summary === 'string' && typeof o.quote === 'string';
}
