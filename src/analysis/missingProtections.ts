import { NO_SUGGESTION, normaliseLaws, guardPriority, riskBasisOf } from './rubric';
import { buildMissingPrompt } from './prompts';
import { groupForRollup } from './rollup';
import type { TaskPlan } from './execute';
import type { DocType } from './docType';
import type { MissingProtection, ReviewingFor } from './types';

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
export function missingPlans(
  clauses: MissingInputClause[],
  defsContext: string,
  focus: string,
  docType: DocType | null = null,
  reviewingFor: ReviewingFor = 'neutral',
): TaskPlan[] {
  const present = [...new Set(clauses.map((c) => c.clause).filter(Boolean))];
  return groupForRollup(clauses).map((group, i) => ({
    suffix: `m${i}`,
    promptVersion: 'missing-protections-v2',
    prompt: buildMissingPrompt({ focus: focus || undefined, docType, checklistOfClauses: present, reviewingFor }),
    input: `${defsContext}\n\nClause summaries:\n${JSON.stringify(group)}`,
    maxTokens: 1500,
    validate: isValidMissingItem,
  }));
}

// Coverage gate for a missing-protection claim.
//
// Measured on a two-page contract (see coverGate.test.ts): reciprocal-rank fusion scores span
// roughly 0.009 to 0.033, and the dense vector list returns every window, so an absent topic still
// gets about 1/61 from a vector rank-1. A fused cutoff therefore cannot separate an absent topic
// from a present one. The keyword list only returns windows that match the topic's words: it is
// empty for "governing law" and "stamp duty" on that contract, and non-empty for "deposit" and
// "notice". So a hit counts as coverage only when it came from the keyword list, and its fused
// score is at least COVER_MIN_FUSED, the RRF floor for a keyword hit at the end of the 50-item
// keyword list (1 / (60 + 50) = 1/110). A weak vector-only hit never covers a claim.
export const COVER_MIN_FUSED = 1 / 110;

export interface CoverageHit {
  fused: number;
  keywordScore?: number;
}

export function hitCoversTopic(hits: CoverageHit[]): boolean {
  return hits.some((h) => (h.keywordScore ?? 0) > 0 && h.fused >= COVER_MIN_FUSED);
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
  search: (query: string, k: number) => Promise<CoverageHit[]>,
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

    let hits: CoverageHit[];
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
    if (hitCoversTopic(hits)) {
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
