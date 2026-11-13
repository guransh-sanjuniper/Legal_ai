import { describe, expect, it } from 'vitest';
import { libraryStatus, needsResumeAfterReview, readyLabel, statusLabel, statusTone } from './docStatus';

describe('library status derivation', () => {
  it('maps ingestion status to a library status', () => {
    expect(libraryStatus('ready')).toBe('ready');
    expect(libraryStatus('review')).toBe('needs_review');
    expect(libraryStatus('processing')).toBe('preparing');
    expect(libraryStatus('new')).toBe('preparing');
  });

  it('labels review counts', () => {
    expect(statusLabel('ready')).toBe('Ready');
    expect(statusLabel('preparing')).toBe('Preparing');
    expect(statusLabel('needs_review', 0)).toBe('Needs review');
    expect(statusLabel('needs_review', 1)).toBe('Needs review (1 page)');
    expect(statusLabel('needs_review', 7)).toBe('Needs review (7 pages)');
  });

  it('assigns chip tones', () => {
    expect(statusTone('ready')).toBe('ok');
    expect(statusTone('needs_review')).toBe('warn');
    expect(statusTone('preparing')).toBe('neutral');
  });
});

describe('ready with pages not reviewed', () => {
  it('labels Ready with the unreviewed page count', () => {
    expect(readyLabel(0)).toBe('Ready');
    expect(readyLabel(1)).toBe('Ready · 1 page not reviewed');
    expect(readyLabel(3)).toBe('Ready · 3 pages not reviewed');
  });

  it('resumes a review document only when no page is left to review', () => {
    expect(needsResumeAfterReview('review', 0)).toBe(true);
    expect(needsResumeAfterReview('review', 2)).toBe(false);
    expect(needsResumeAfterReview('ready', 0)).toBe(false);
  });
});
