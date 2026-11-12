import type { DocStatus, DocumentRecord } from '../../runner/db';
import type { PreparationState, PreparationStage } from './preparationState';

export type LibraryStatus = 'preparing' | 'needs_review' | 'ready' | 'failed';
export type StatusTone = 'neutral' | 'warn' | 'ok' | 'danger';

// The document-level ingestion status stays authoritative. The review count only changes
// the label; it is never used to decide readiness.
export function libraryStatus(status: DocStatus): LibraryStatus {
  if (status === 'ready') return 'ready';
  if (status === 'review') return 'needs_review';
  return 'preparing';
}

export interface LibraryStatusView {
  doc: DocumentRecord;
  prepared: boolean;
  state: PreparationState | null;
  reviewPages: number;
}

// The library's "Ready" is the durable preparation result, not the ingestion status:
// chunks, embeddings and the definitions sheet must all exist for the document.
export function libraryStatusFrom(view: LibraryStatusView): LibraryStatus {
  if (view.prepared) return 'ready';
  if (view.state?.stage === 'failed') return 'failed';
  if (view.doc.status === 'review' || view.state?.stage === 'needs-review') return 'needs_review';
  return 'preparing';
}

export function stageLabel(stage: PreparationStage | null): string {
  switch (stage) {
    case 'ingest':
      return 'Extract & OCR';
    case 'embeddings':
      return 'Embeddings';
    case 'index':
      return 'Keyword index';
    case 'definitions':
      return 'Definitions';
    case 'ready':
      return 'Ready';
    case 'needs-review':
      return 'Needs review';
    case 'failed':
      return 'Failed';
    default:
      return 'Preparing';
  }
}

export function statusLabel(status: LibraryStatus, reviewPages = 0, stage?: PreparationStage | null): string {
  if (status === 'ready') return 'Ready';
  if (status === 'needs_review') {
    if (reviewPages <= 0) return 'Needs review';
    return `Needs review (${reviewPages} page${reviewPages === 1 ? '' : 's'})`;
  }
  if (status === 'failed') return 'Failed';
  if (stage) return `Preparing · ${stageLabel(stage)}`;
  return 'Preparing';
}

export function statusTone(status: LibraryStatus): StatusTone {
  if (status === 'ready') return 'ok';
  if (status === 'needs_review') return 'warn';
  if (status === 'failed') return 'danger';
  return 'neutral';
}
