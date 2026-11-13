import type { OverviewPoint, RollupSentence } from './types';

// Executive Summary guards.

// A gap is stated only when the verified Missing list has an entry. This matches explicit
// absence claims, not any sentence that happens to contain "not".
const GAP_CLAIM =
  /^(there is no|there are no|no [^.]{0,40}(is|are) (provided|included|stated|addressed|specified)|no provision (is|for)|does not (contain|include|provide|address|specify|deal with)|fails? to (provide|address|include|specify)|(is|are) (absent|missing|not addressed))/i;

export function dropGapClaims<T extends { text: string }>(sentences: T[], hasVerifiedMissing: boolean): { kept: T[]; dropped: number } {
  if (hasVerifiedMissing) return { kept: sentences, dropped: 0 };
  const kept = sentences.filter((s) => !GAP_CLAIM.test(s.text.trim()));
  return { kept, dropped: sentences.length - kept.length };
}

// The summary is short: the nature, the parties, the commercial terms and the top risk, at most
// six cited sentences. Nothing unverified is used because every sentence keeps its own citation.
export const FALLBACK_POINTS = [1, 2, 4, 8, 13] as const;

export function fallbackSummary(points: OverviewPoint[]): RollupSentence[] {
  const out: RollupSentence[] = [];
  for (const point of FALLBACK_POINTS) {
    const p = points.find((x) => x.point === point);
    const sentence = p?.sentences.find((s) => s.cites.length > 0);
    if (sentence) out.push(sentence);
    if (out.length >= 3) break;
  }
  // Top risks next, until six sentences at most.
  const risks = points.filter((p) => !FALLBACK_POINTS.includes(p.point as never)).flatMap((p) => p.sentences);
  for (const s of risks) {
    if (out.length >= 6) break;
    if (s.cites.length > 0) out.push(s);
  }
  return out.slice(0, 6);
}
