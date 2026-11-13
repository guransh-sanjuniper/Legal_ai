import type { TaskPlan } from './execute';
import { buildRiskReviewPrompt } from './prompts';
import { normaliseClauseNo } from './reportModel';
import type { RiskPriority } from './rubric';

// Validation pass over High and Medium risks. A batched, cheap review that keeps, downgrades or
// drops each proposed risk, plus duplicate removal (same clause and issue). Low risks are not sent.

export interface RiskReviewItem {
  id: string;
  clause: string;
  priority: RiskPriority;
  issue: string;
  quote: string;
}

export type RiskVerdict = 'keep' | 'downgrade' | 'drop';

export interface RiskVerdictItem {
  id: string;
  verdict: RiskVerdict;
  reason: string;
}

export function isValidVerdictItem(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.id === 'string' && ['keep', 'downgrade', 'drop'].includes(o.verdict as string);
}

const issueKey = (clause: string, issue: string) =>
  `${normaliseClauseNo(clause)}|${issue.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;

// Duplicate risks: same clause and same normalised issue. The first one wins.
export function duplicateRiskIds<T extends { id: string; clause: string; issue: string }>(items: T[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const item of items) {
    const key = issueKey(item.clause, item.issue);
    if (seen.has(key)) dupes.add(item.id);
    else seen.add(key);
  }
  return dupes;
}

export const RISK_REVIEW_BATCH = 20;

export function riskReviewPlans(items: RiskReviewItem[]): TaskPlan[] {
  const plans: TaskPlan[] = [];
  for (let i = 0; i < items.length; i += RISK_REVIEW_BATCH) {
    const batch = items.slice(i, i + RISK_REVIEW_BATCH);
    plans.push({
      suffix: `rq${i / RISK_REVIEW_BATCH}`,
      promptVersion: 'risk-review-v1',
      prompt: buildRiskReviewPrompt(),
      input: JSON.stringify(batch),
      maxTokens: 900,
      validate: isValidVerdictItem,
    });
  }
  return plans;
}

export interface AppliedVerdicts {
  downgraded: Set<string>;
  dropped: Set<string>;
}

// Applies verdicts by id. An id with no verdict is left as proposed (fail open).
export function applyVerdicts(items: RiskVerdictItem[]): AppliedVerdicts {
  const downgraded = new Set<string>();
  const dropped = new Set<string>();
  for (const item of items) {
    if (item.verdict === 'downgrade') downgraded.add(item.id);
    else if (item.verdict === 'drop') dropped.add(item.id);
  }
  for (const id of downgraded) dropped.delete(id);
  return { downgraded, dropped };
}
