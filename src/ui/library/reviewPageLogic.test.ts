import { describe, expect, it } from 'vitest';
import { allPagesResolved, needsDecision, reviewDecisionFor } from './reviewPageLogic';

describe('needsDecision', () => {
  it('treats a review page and a waived page as unresolved', () => {
    expect(needsDecision({ status: 'review', source: null })).toBe(true);
    expect(needsDecision({ status: 'accepted', source: 'waived' })).toBe(true);
  });

  it('treats every final, human-decided page as resolved', () => {
    expect(needsDecision({ status: 'native', source: null })).toBe(false);
    expect(needsDecision({ status: 'ocr', source: null })).toBe(false);
    expect(needsDecision({ status: 'accepted', source: 'manual' })).toBe(false);
    expect(needsDecision({ status: 'blank', source: 'manual' })).toBe(false);
  });
});

describe('allPagesResolved', () => {
  it('is false while any page still needs a decision', () => {
    expect(
      allPagesResolved([
        { status: 'accepted', source: 'manual' },
        { status: 'review', source: null },
      ]),
    ).toBe(false);
    expect(
      allPagesResolved([
        { status: 'native', source: null },
        { status: 'accepted', source: 'waived' },
      ]),
    ).toBe(false);
  });

  it('is true only when every page is final and human-confirmed or automatic', () => {
    expect(allPagesResolved([])).toBe(true);
    expect(
      allPagesResolved([
        { status: 'native', source: null },
        { status: 'accepted', source: 'manual' },
        { status: 'blank', source: 'manual' },
      ]),
    ).toBe(true);
  });

  it('does not depend on page order', () => {
    const resolved = { status: 'accepted' as const, source: 'manual' as const };
    const pending = { status: 'review' as const, source: null };
    expect(allPagesResolved([resolved, pending, resolved])).toBe(false);
    expect(allPagesResolved([resolved, resolved, resolved])).toBe(true);
  });
});

describe('reviewDecisionFor', () => {
  it('turns Accept on empty or whitespace text into the Leave blank decision', () => {
    expect(reviewDecisionFor('accept', '')).toBe('blank');
    expect(reviewDecisionFor('accept', '   \n\t ')).toBe('blank');
  });

  it('keeps Accept for text and keeps the other actions unchanged', () => {
    expect(reviewDecisionFor('accept', 'Some OCR text')).toBe('accept');
    expect(reviewDecisionFor('correct', '')).toBe('correct');
    expect(reviewDecisionFor('correct', 'Edited text')).toBe('correct');
    expect(reviewDecisionFor('blank', 'ignored')).toBe('blank');
  });
});
