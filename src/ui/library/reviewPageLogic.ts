import type { PageRecord } from '../../runner/db';
import type { ReviewDecision } from '../../ingest/review';

// Pure decisions for the page-review screen. The screen and the last-page check use
// the same definition so a waived page keeps the document waiting for a person.

export type ReviewPageState = Pick<PageRecord, 'status' | 'source'>;
export type ReviewAction = 'accept' | 'correct' | 'blank';

export function needsDecision(page: ReviewPageState): boolean {
  return page.status === 'review' || page.source === 'waived';
}

export function allPagesResolved(pages: ReviewPageState[]): boolean {
  return !pages.some(needsDecision);
}

// Accept on empty text is the same action as Leave blank: the caller passes the
// returned decision straight to saveReviewDecision, with no text for both.
export function reviewDecisionFor(action: ReviewAction, text: string): ReviewDecision {
  if (action === 'accept') return text.trim() === '' ? 'blank' : 'accept';
  if (action === 'correct') return 'correct';
  return 'blank';
}
