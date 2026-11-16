import type { DraftStatus } from '../../drafter/types';

// Plain labels for the drafts list. The stored status values are unchanged.
const LABELS: Record<DraftStatus, string> = {
  brief: 'Brief',
  planned: 'Plan ready',
  outlined: 'Outline ready',
  generating: 'Writing',
  done: 'Done',
  failed: 'Failed',
};

export function draftStatusText(status: DraftStatus): string {
  return LABELS[status] ?? status;
}
