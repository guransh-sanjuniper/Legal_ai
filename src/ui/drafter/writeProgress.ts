import type { ClauseRecord, OutlineItem } from '../../drafter/types';

// Progress and auto-start decisions for the Write screen. Pure functions: the page supplies
// the stored clauses and the current item fingerprints; nothing here calls a model or
// changes a draft.

export type WriteItemClass = 'done' | 'verbatim' | 'stale' | 'failed' | 'pending';

export interface WriteCounts {
  total: number;
  done: number;
  verbatim: number;
  // In-flight calls reported by the UI runner. This is an overlay, not an item status.
  writing: number;
  failed: number;
  stale: number;
  pending: number;
}

export interface WriteState {
  counts: WriteCounts;
  // Items a batch run may write: pending, stale or missing, never failed.
  pendingIds: string[];
}

export interface WriteProgress {
  done: number;
  total: number;
  percent: number;
  label: string;
  complete: boolean;
}

export type WriteStartAction =
  | 'start'
  | 'attach'
  | 'blocked:outline'
  | 'blocked:sources'
  | 'blocked:lock'
  | 'finished'
  | 'wait';

export interface WriteStartInput {
  counts: WriteCounts;
  outlineStale: boolean;
  sourcesStale: boolean;
  sourcesUnconfirmed: boolean;
  running: boolean;
  lockHeld: boolean;
  userStopped: boolean;
  startedThisVisit: boolean;
  // True when the engine can write a subset (the onlyItemIds option). A batch can then
  // write pending/stale sections while leaving failed sections untouched.
  pendingOnlyStart: boolean;
}

export interface SourceGate {
  stale: boolean;
  unconfirmed: boolean;
}

// A stale sourceText only matters when the current plan actually needs source text. With no
// verbatim/adapt bindings, sourceTextReady is true and leftover stale text must not block.
export function sourceGate(ready: boolean, stale: boolean): SourceGate {
  return {
    stale: !ready && stale,
    unconfirmed: !ready && !stale,
  };
}

export interface WriteStartReasonOptions {
  userStopped?: boolean;
  failed?: number;
}

// Every non-start/non-attach/non-finished decision has a plain reason for the page to show.
export function writeStartReason(
  action: WriteStartAction,
  options: WriteStartReasonOptions = {},
): string | null {
  switch (action) {
    case 'blocked:outline':
      return 'The plan changed after this structure was made. Update the structure before writing.';
    case 'blocked:sources':
      return "Check and confirm the parts I'll use before writing.";
    case 'blocked:lock':
      return 'This draft is already being written in another tab.';
    case 'wait':
      if (options.userStopped) return 'Writing is paused. Use Resume to continue.';
      if ((options.failed ?? 0) > 0) {
        return 'Some sections need attention. Use Try again next to each one.';
      }
      return 'Writing did not start. Use Try again when you are ready.';
    default:
      return null;
  }
}

export function classifyWriteItem(
  item: OutlineItem,
  record: ClauseRecord | undefined,
  fingerprint: string,
): WriteItemClass {
  if (!record) return 'pending';
  if (record.status === 'failed') return 'failed';
  if (record.status === 'done' || record.status === 'verbatim') {
    return record.itemFingerprint === fingerprint ? record.status : 'stale';
  }
  // pending/writing records need writing again; the live call count is separate.
  return 'pending';
}

export function analyseWriteState(
  items: OutlineItem[],
  clauses: Record<string, ClauseRecord>,
  fingerprintOf: (item: OutlineItem) => string,
  writingNow = 0,
): WriteState {
  const counts: WriteCounts = {
    total: items.length,
    done: 0,
    verbatim: 0,
    writing: Math.max(0, Math.floor(writingNow)),
    failed: 0,
    stale: 0,
    pending: 0,
  };
  const pendingIds: string[] = [];

  for (const item of items) {
    const kind = classifyWriteItem(item, clauses[item.id], fingerprintOf(item));
    if (kind === 'done') counts.done++;
    else if (kind === 'verbatim') counts.verbatim++;
    else if (kind === 'failed') counts.failed++;
    else if (kind === 'stale') {
      counts.stale++;
      pendingIds.push(item.id);
    } else {
      counts.pending++;
      pendingIds.push(item.id);
    }
  }

  return { counts, pendingIds };
}

export function writeProgress(counts: WriteCounts): WriteProgress {
  const total = Math.max(0, counts.total);
  const done = Math.min(total, Math.max(0, counts.done + counts.verbatim));
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0;
  return {
    done,
    total,
    percent,
    label: total === 0 ? 'No sections' : `${done} of ${total} sections done`,
    complete: total > 0 && done >= total,
  };
}

export function decideWriteStart(input: WriteStartInput): WriteStartAction {
  const { counts } = input;
  const remaining = counts.pending + counts.stale;
  const freshDone = counts.done + counts.verbatim;
  const finished =
    counts.total === 0 ||
    (freshDone >= counts.total && counts.failed === 0 && remaining === 0);

  // Attach to a run already in progress before considering any other rule.
  if (input.running) return 'attach';
  // One automatic attempt per page visit. A running check above still allows attaching.
  if (input.startedThisVisit) return 'wait';
  if (input.outlineStale) return 'blocked:outline';
  if (input.sourcesStale || input.sourcesUnconfirmed) return 'blocked:sources';
  if (finished) return 'finished';
  if (input.lockHeld) return 'blocked:lock';
  if (input.userStopped) return 'wait';
  if (remaining > 0) {
    if (counts.failed === 0 || input.pendingOnlyStart) return 'start';
    return 'wait';
  }
  if (counts.failed > 0) return 'wait';
  return 'finished';
}
