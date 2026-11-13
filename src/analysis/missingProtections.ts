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
  // The matched text of the hit, used to check the topic's own words actually appear.
  windowText?: string;
  pageStart?: number;
}

// Words that say nothing about the topic itself.
const GENERIC = new Set(
  `law laws act acts clause clauses party parties agreement contract document documents term terms provision provisions
   payment payments amount amounts process mechanics who pays payer and the of to for in on with or a an is are be should
   shall must any all this that by from as at`.split(/\s+/),
);

const normaliseWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Six-character stem, so "refund" matches "refund mechanics" and "indemnity" matches "indemnify".
const stem = (w: string) => w.slice(0, Math.min(6, w.length));

export function coreTerms(topic: string): string[] {
  return [...new Set(normaliseWords(topic).split(' ').filter((w) => w && !GENERIC.has(w)))];
}

// A hit covers the topic only when the matched text contains the topic's own words: the full
// phrase, or every non-generic core term (compared by stem). A hit that only contains a generic
// word such as "law" never covers.
export function hitCoversTopic(hits: CoverageHit[], topic: string): boolean {
  const terms = coreTerms(topic);
  const phrase = normaliseWords(topic);
  return hits.some((h) => {
    if ((h.keywordScore ?? 0) <= 0 || h.fused < COVER_MIN_FUSED) return false;
    const text = normaliseWords(h.windowText ?? '');
    if (!text) return false;
    if (phrase && text.includes(phrase)) return true;
    if (terms.length === 0) return false;
    const words = new Set(text.split(' ').filter(Boolean).map(stem));
    return terms.every((t) => words.has(stem(t)));
  });
}

export interface MissingCheckResult {
  // Verified missing: the search found a weak hit, which is not coverage.
  kept: MissingProtection[];
  // Kept, but the search failed or returned nothing. Shown apart, never used as a gap claim.
  possiblyMissing: MissingProtection[];
  coveredInDocument: number;
  unchecked: number;
  proposed: number;
  drops: MissingDrop[];
}

export interface MissingDrop {
  topic: string;
  page: number;
  fused: number;
  keywordScore: number;
}

// A claim of absence is kept only when the whole-document search finds nothing for its topic.
// If the search fails, the claim is left out and counted, never shown as checked.
export async function keepMissingClaims(
  items: unknown[],
  validClauseIds: Set<string>,
  search: (query: string, k: number) => Promise<CoverageHit[]>,
): Promise<MissingCheckResult> {
  const kept: MissingProtection[] = [];
  const possiblyMissing: MissingProtection[] = [];
  const seenTopics = new Set<string>();
  let coveredInDocument = 0;
  let unchecked = 0;
  let proposed = 0;
  const drops: MissingDrop[] = [];
  for (const raw of items) {
    if (!isValidMissingItem(raw)) continue;
    const o = raw as Record<string, unknown>;
    const topic = (o.topic as string).replace(/\s+/g, ' ').trim();
    const text = (o.text as string).replace(/\s+/g, ' ').trim();
    const key = topic.toLowerCase();
    if (!topic || !text || seenTopics.has(key)) continue;
    seenTopics.add(key);
    proposed++;

    let hits: CoverageHit[] | null = null;
    let searchFailed = false;
    try {
      hits = await search(topic, 5);
      if (!Array.isArray(hits)) searchFailed = true;
    } catch {
      searchFailed = true;
    }
    if (searchFailed) {
      unchecked++;
      hits = null;
    } else if (hits && hitCoversTopic(hits, topic)) {
      coveredInDocument++;
      const best = [...hits].sort((a, b) => b.fused - a.fused)[0];
      drops.push({ topic, page: best?.pageStart ?? 0, fused: best?.fused ?? 0, keywordScore: best?.keywordScore ?? 0 });
      continue;
    }

    const basis = riskBasisOf(o.basis);
    const cites = Array.isArray(o.cites)
      ? [...new Set(o.cites.filter((c): c is string => typeof c === 'string' && validClauseIds.has(c)))]
      : [];
    const claim: MissingProtection = {
      itemId: `M${kept.length + possiblyMissing.length + 1}`,
      topic,
      text,
      severity: guardPriority(o.priority, basis),
      basis,
      suggestion: typeof o.suggestion === 'string' && o.suggestion.trim() ? o.suggestion.trim() : NO_SUGGESTION,
      laws: normaliseLaws(o.laws),
      cites,
      applicability: 'unverified',
    };
    // A failed search or an empty result does not verify the absence: keep it apart.
    if (hits === null || hits.length === 0) possiblyMissing.push(claim);
    else kept.push(claim);
  }
  return { kept, possiblyMissing, coveredInDocument, unchecked, proposed, drops };
}
