import { describe, it, expect } from 'vitest';
import {
  RISK_REVIEW_BATCH,
  applyVerdicts,
  duplicateRiskIds,
  isValidVerdictItem,
  riskReviewPlans,
  type RiskReviewItem,
} from './riskReview';

const item = (id: string, over: Partial<RiskReviewItem> = {}): RiskReviewItem => ({
  id,
  clause: '4',
  priority: 'medium',
  issue: 'One-sided penalty',
  quote: 'a quote',
  ...over,
});

describe('risk validation', () => {
  it('flags duplicates by clause and normalised issue', () => {
    const dupes = duplicateRiskIds([
      item('r1', { issue: 'One-sided penalty' }),
      item('r2', { issue: 'one-sided   PENALTY' }),
      item('r3', { issue: 'Uncapped repairs' }),
      item('r4', { clause: '5', issue: 'One-sided penalty' }),
    ]);
    expect([...dupes]).toEqual(['r2']);
  });

  it('batches reviews, one task per batch, up to the batch size', () => {
    const items = Array.from({ length: RISK_REVIEW_BATCH * 2 + 3 }, (_, i) => item(`r${i}`, { issue: `issue ${i}` }));
    const plans = riskReviewPlans(items);
    expect(plans).toHaveLength(3);
    expect(plans[0].input).toBe(JSON.stringify(items.slice(0, RISK_REVIEW_BATCH)));
    expect(plans[0].prompt).toMatch(/NOT risks/);
    expect(plans[0].prompt).toMatch(/stays a risk even when phrased as a disclaimer/);
  });

  it('applies keep, downgrade and drop, and never both downgrades and drops one id', () => {
    const applied = applyVerdicts([
      { id: 'a', verdict: 'keep', reason: '' },
      { id: 'b', verdict: 'downgrade', reason: '' },
      { id: 'c', verdict: 'drop', reason: '' },
      { id: 'd', verdict: 'drop', reason: '' },
      { id: 'd', verdict: 'downgrade', reason: '' },
    ]);
    expect([...applied.downgraded]).toEqual(['b', 'd']);
    expect([...applied.dropped]).toEqual(['c']);
  });

  it('accepts only well-formed verdict items', () => {
    expect(isValidVerdictItem({ id: 'r1', verdict: 'drop' })).toBe(true);
    expect(isValidVerdictItem({ id: 'r1', verdict: 'maybe' })).toBe(false);
    expect(isValidVerdictItem({ verdict: 'drop' })).toBe(false);
  });
});
