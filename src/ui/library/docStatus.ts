import type { DocStatus } from '../../runner/db';

export type LibraryStatus = 'preparing' | 'needs_review' | 'ready';
export type StatusTone = 'neutral' | 'warn' | 'ok';

// The document-level ingestion status stays authoritative. The review count only changes
// the label; it is never used to decide readiness.
export function libraryStatus(status: DocStatus): LibraryStatus {
  if (status === 'ready') return 'ready';
  if (status === 'review') return 'needs_review';
  return 'preparing';
}

export function statusLabel(status: LibraryStatus, reviewPages = 0): string {
  if (status === 'ready') return 'Ready';
  if (status === 'needs_review') {
    if (reviewPages <= 0) return 'Needs review';
    return `Needs review (${reviewPages} page${reviewPages === 1 ? '' : 's'})`;
  }
  return 'Preparing';
}

export function statusTone(status: LibraryStatus): StatusTone {
  if (status === 'ready') return 'ok';
  if (status === 'needs_review') return 'warn';
  return 'neutral';
}
