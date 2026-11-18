import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { itemFingerprint } from '../../drafter/write';
import { getDraft, openDrafterDb } from '../../drafter/store';
import { subscribeAnyWriting } from '../drafter/writeRunner';
import { analyseWriteState, writeProgress } from '../drafter/writeProgress';
import {
  DRAFTER_TOAST_ACTION,
  DRAFTER_TOAST_TEXT,
  TOAST_MS,
  draftRunKey,
  isDraftScreen,
  isExpired,
  nextRemaining,
  shouldToastDraftReady,
  subscribeToast,
  toastStore,
  type DraftRunLike,
  type ToastMessage,
} from './toast';
import './toast.css';

// One completion notice at a time, mounted once by the app shell so a Drafter run that
// keeps going on another page can still say it is ready. Never steals focus, never
// blocks the page, and nothing about it is stored.
export function ToastHost() {
  const [toast, setToast] = useState<ToastMessage | null>(() => toastStore.current());
  const location = useLocation();
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  // One store subscription for the lifetime of the shell.
  useEffect(() => subscribeToast(setToast), []);

  // Auto-dismiss: 8 s, paused while the toast is hovered or focused, then resumed for
  // the time that was left. A newer toast re-arms a fresh countdown.
  const remainingRef = useRef(TOAST_MS);
  const startedRef = useRef(0);
  const pausedRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function arm(ms: number, id: number) {
    clearTimer();
    remainingRef.current = ms;
    startedRef.current = Date.now();
    timerRef.current = window.setTimeout(() => {
      // Only dismiss the toast this timer was armed for.
      if (toastStore.current()?.id === id) toastStore.dismiss();
    }, ms);
  }

  useEffect(() => {
    if (!toast) {
      clearTimer();
      return;
    }
    pausedRef.current = false;
    arm(TOAST_MS, toast.id);
    return clearTimer;
    // Re-arm only for a new toast, never for a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.id]);

  function pause() {
    if (!toast || pausedRef.current) return;
    pausedRef.current = true;
    remainingRef.current = nextRemaining(remainingRef.current, Date.now() - startedRef.current);
    clearTimer();
  }

  function resume() {
    if (!toast || !pausedRef.current) return;
    pausedRef.current = false;
    if (isExpired(remainingRef.current)) {
      toastStore.dismiss();
      return;
    }
    arm(remainingRef.current, toast.id);
  }

  function close() {
    toastStore.dismiss();
  }

  // Drafter: the shell hears every write run in this tab. A run seen starting and then
  // ending normally is checked against the stored draft with the existing pure helpers.
  const notifiedRef = useRef<Set<string>>(new Set());

  async function announceDraftReady(
    draftId: string,
    runKey: string,
    run: DraftRunLike,
    previousKeys: readonly string[],
  ) {
    try {
      const db = await openDrafterDb();
      const draft = await getDraft(db, draftId);
      if (!draft || !draft.outline) return;
      const state = analyseWriteState(
        draft.outline.items,
        draft.clauses,
        (item) => itemFingerprint(item, draft),
      );
      const ok = shouldToastDraftReady({
        sawRunStart: true,
        run,
        runKey,
        notifiedKeys: previousKeys,
        complete: writeProgress(state.counts).complete,
        failedOrStale: state.counts.failed + state.counts.stale > 0,
        // Read the route now, not when the listener was registered.
        onDraftScreen: isDraftScreen(pathnameRef.current, draftId),
      });
      if (!ok) return;
      toastStore.publish({
        text: DRAFTER_TOAST_TEXT,
        actionLabel: DRAFTER_TOAST_ACTION,
        actionHref: `/draft/${draftId}/write`,
      });
    } catch {
      // The draft could not be read: show nothing. A notice never disturbs the writer.
    }
  }

  useEffect(() => {
    // draftId -> the startedAt seen while its run was active in this tab.
    const runs = new Map<string, string | null>();
    return subscribeAnyWriting((draftId, live) => {
      if (live.active) {
        const seen = live.run?.startedAt ?? null;
        if (seen) runs.set(draftId, seen);
        return;
      }
      const sawRunStart = runs.has(draftId);
      const startedAt = runs.get(draftId) ?? null;
      runs.delete(draftId);
      if (!sawRunStart || !startedAt) return;
      // Ignore a run record that is not the one this tab watched start.
      if (!live.run || live.run.startedAt !== startedAt) return;
      const runKey = draftRunKey(draftId, startedAt);
      const previousKeys = [...notifiedRef.current];
      if (!runKey || previousKeys.includes(runKey)) return;
      // Reserve the run straight away, so two updates can never announce it twice.
      notifiedRef.current.add(runKey);
      void announceDraftReady(draftId, runKey, live.run, previousKeys);
    });
    // Registered once for the shell; the listener reads the route from a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-toast-host" role="status" aria-live="polite" aria-atomic="true">
      {toast && (
        <div
          className="app-toast"
          onMouseEnter={pause}
          onMouseLeave={resume}
          onFocus={pause}
          onBlur={resume}
        >
          <p className="app-toast-text">{toast.text}</p>
          <div className="app-toast-actions">
            {toast.actionLabel && toast.actionHref ? (
              <Link className="app-toast-action" to={toast.actionHref} onClick={close}>
                {toast.actionLabel}
              </Link>
            ) : toast.actionLabel && toast.onAction ? (
              <button
                type="button"
                className="app-toast-action"
                onClick={() => {
                  toast.onAction?.();
                  close();
                }}
              >
                {toast.actionLabel}
              </button>
            ) : null}
            <button type="button" className="app-toast-close" aria-label="Close notification" onClick={close}>
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
