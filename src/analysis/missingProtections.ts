import { NO_SUGGESTION, normaliseLaws, guardPriority, riskBasisOf } from './rubric';
import { buildMissingPrompt } from './prompts';
import { groupForRollup } from './rollup';
import type { TaskPlan } from './execute';
import type { MissingProtection } from './types';

export interface MissingInputClause {
  id: string;
  clause: string;
  type: string;
  summary: string;
}

export function isValidMissingItem(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.topic === 'string' && typeof o.text === 'string';
}

// One task per group of clause summaries, so a long document stays within the input limit.
export function missingPlans(clauses: MissingInputClause[], defsContext: string, focus: string): TaskPlan[] {
  return groupForRollup(clauses).map((group, i) => ({
    suffix: `m${i}`,
    promptVersion: 'missing-protections-v1',
    prompt: buildMissingPrompt(focus || undefined),
    input: `${defsContext}\n\nClause summaries:\n${JSON.stringify(group)}`,
    maxTokens: 1500,
    validate: isValidMissingItem,
  }));
}

export interface MissingCheckResult {
  kept: MissingProtection[];
  coveredInDocument: number;
  unchecked: number;
}

// A claim of absence is kept only when the whole-document search finds nothing for its topic.
// If the search fails, the claim is left out and counted, never shown as checked.
export async function keepMissingClaims(
  items: unknown[],
  validClauseIds: Set<string>,
  search: (query: string, k: number) => Promise<{ fused: number }[]>,
): Promise<MissingCheckResult> {
  const kept: MissingProtection[] = [];
  const seenTopics = new Set<string>();
  let coveredInDocument = 0;
  let unchecked = 0;
  for (const raw of items) {
    if (!isValidMissingItem(raw)) continue;
    const o = raw as Record<string, unknown>;
    const topic = (o.topic as string).replace(/\s+/g, ' ').trim();
    const text = (o.text as string).replace(/\s+/g, ' ').trim();
    const key = topic.toLowerCase();
    if (!topic || !text || seenTopics.has(key)) continue;
    seenTopics.add(key);

    let hits: { fused: number }[];
    try {
      hits = await search(topic, 5);
    } catch {
      unchecked++;
      continue;
    }
    if (!Array.isArray(hits)) {
      unchecked++;
      continue;
    }
    if (hits.some((h) => h.fused > 0)) {
      coveredInDocument++;
      continue;
    }

    const basis = riskBasisOf(o.basis);
    const cites = Array.isArray(o.cites)
      ? [...new Set(o.cites.filter((c): c is string => typeof c === 'string' && validClauseIds.has(c)))]
      : [];
    kept.push({
      itemId: `M${kept.length + 1}`,
      topic,
      text,
      severity: guardPriority(o.priority, basis),
      basis,
      suggestion: typeof o.suggestion === 'string' && o.suggestion.trim() ? o.suggestion.trim() : NO_SUGGESTION,
      laws: normaliseLaws(o.laws),
      cites,
      applicability: 'unverified',
    });
  }
  return { kept, coveredInDocument, unchecked };
}
