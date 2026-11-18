// Completion notices: the trigger decisions, the small in-memory toast store and the
// auto-dismiss timer maths. Pure apart from the store's own counter and listener set:
// no DOM, no timers, no storage. Nothing here is ever written to IndexedDB, localStorage
// or Supabase, so closing the tab loses the notice and nothing else.

export const TOAST_MS = 8000;

// ---------------------------------------------------------------------------
// Store: one toast at a time; a newer one replaces the older one.
// ---------------------------------------------------------------------------

export interface ToastRequest {
  text: string;
  actionLabel?: string;
  // A route for the action (rendered as a router link, so the leave guard still sees it).
  actionHref?: string;
  // A page action instead of a route (used by "View report").
  onAction?: () => void;
}

export interface ToastMessage extends ToastRequest {
  id: number;
}

export type ToastListener = (message: ToastMessage | null) => void;

export interface ToastStore {
  publish(request: ToastRequest): ToastMessage;
  dismiss(): void;
  current(): ToastMessage | null;
  subscribe(listener: ToastListener): () => void;
}

export function createToastStore(): ToastStore {
  let current: ToastMessage | null = null;
  let nextId = 1;
  const listeners = new Set<ToastListener>();

  const notify = () => {
    for (const listener of listeners) listener(current);
  };

  return {
    publish(request: ToastRequest): ToastMessage {
      current = { ...request, id: nextId++ };
      notify();
      return current;
    },
    dismiss(): void {
      if (!current) return;
      current = null;
      notify();
    },
    current(): ToastMessage | null {
      return current;
    },
    subscribe(listener: ToastListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const toastStore = createToastStore();

export function publishToast(request: ToastRequest): ToastMessage {
  return toastStore.publish(request);
}

export function dismissToast(): void {
  toastStore.dismiss();
}

export function subscribeToast(listener: ToastListener): () => void {
  return toastStore.subscribe(listener);
}

// ---------------------------------------------------------------------------
// Auto-dismiss timer: counts down TOAST_MS, holds its remaining time while the toast is
// hovered or focused, and never counts past zero.
// ---------------------------------------------------------------------------

export function nextRemaining(remaining: number, elapsed: number): number {
  const left = Math.max(0, Math.min(TOAST_MS, Number.isFinite(remaining) ? remaining : TOAST_MS));
  const spent = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  return Math.max(0, left - spent);
}

export function isExpired(remaining: number): boolean {
  return remaining <= 0;
}

// ---------------------------------------------------------------------------
// Deep Analysis: the page reports the finish itself, so a loaded or restored report and
// a failed run with nothing to show never reach here.
// ---------------------------------------------------------------------------

export interface AnalysisToastInput {
  finishedThisVisit: boolean;
  reportShown: boolean;
}

export function shouldToastAnalysis(input: AnalysisToastInput): boolean {
  return input.finishedThisVisit && input.reportShown;
}

export const ANALYSIS_TOAST_TEXT = 'Deep Analysis report is ready.';
export const ANALYSIS_TOAST_ACTION = 'View report';

// ---------------------------------------------------------------------------
// Drafter: the shell hears every write runner update. A notice is shown only when a run
// that started in this visit ends normally with the whole draft finished.
// ---------------------------------------------------------------------------

export interface DraftRunLike {
  startedAt: string;
  finishedAt: string | null;
  stopped?: boolean;
}

export interface DraftToastInput {
  // False on page load or reopening an already finished draft: no run was seen starting.
  sawRunStart: boolean;
  run: DraftRunLike | null;
  // `${draftId}:${run.startedAt}`, so one run can only ever be announced once.
  runKey: string | null;
  notifiedKeys: readonly string[];
  // writeProgress(analyseWriteState(...).counts).complete
  complete: boolean;
  // counts.failed + counts.stale > 0
  failedOrStale: boolean;
  // The user is already on that draft's own screen (write or review), which shows the result.
  onDraftScreen: boolean;
}

export function draftRunKey(draftId: string, startedAt: string | null | undefined): string | null {
  return draftId && startedAt ? `${draftId}:${startedAt}` : null;
}

// True on the draft's write screen and its review screen. Pure: the caller passes the
// current pathname, read at the time of the update rather than when subscribing.
export function isDraftScreen(pathname: string, draftId: string): boolean {
  if (!pathname || !draftId) return false;
  const base = `/draft/${draftId}`;
  return pathname === `${base}/write` || pathname === `${base}/review`;
}

export function shouldToastDraftReady(input: DraftToastInput): boolean {
  if (!input.sawRunStart) return false;
  const run = input.run;
  if (!run || !run.finishedAt) return false;
  if (run.stopped) return false;
  if (!input.complete || input.failedOrStale) return false;
  if (!input.runKey || input.notifiedKeys.includes(input.runKey)) return false;
  if (input.onDraftScreen) return false;
  return true;
}

export const DRAFTER_TOAST_TEXT =
  'Your draft is ready. You can review it and download it as a Word file.';
export const DRAFTER_TOAST_ACTION = 'Open draft';
