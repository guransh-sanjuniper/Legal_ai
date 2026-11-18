import { supabase } from '../../lib/supabase';
import { freshToken, functionsEndpoint } from '../analysis/runtime';
import {
  DRAFTER_CONCURRENCY,
  DRAFTER_WRITE_MAX_TOKENS,
  DRAFTER_WRITE_MODEL,
} from '../../drafter/config';
import { runWithDraftLock, runWriting } from '../../drafter/write';
import { writeSection } from '../../drafter/writeCall';
import type { DrafterDBHandle } from '../../drafter/store';
import { syncDraftById } from '../../drafter/sync';
import type { ClauseRecord, DraftRecord, WriteRun } from '../../drafter/types';

// The run lives outside React so navigating between app screens does not stop it. Closing the
// tab kills in-flight calls; finished clauses are already saved and Resume picks up the rest.

export interface WriteLive {
  clauses: Record<string, ClauseRecord>;
  run: WriteRun | null;
  // Calls in flight right now (UI only; the engine does not persist a "writing" status).
  writing: number;
  // False after the final save or after a stopped run has finished.
  active: boolean;
}

type Listener = (live: WriteLive) => void;

interface Runner {
  stop: { stopped: boolean };
  listeners: Set<Listener>;
}

const runners = new Map<string, Runner>();
// Listeners and the latest live state survive before/after a runner exists, so a page can
// subscribe before auto-start and a revisit can attach to a run already in progress.
const listenersByDraft = new Map<string, Set<Listener>>();
const liveByDraft = new Map<string, WriteLive>();

function listenersFor(draftId: string): Set<Listener> {
  let listeners = listenersByDraft.get(draftId);
  if (!listeners) {
    listeners = new Set<Listener>();
    listenersByDraft.set(draftId, listeners);
  }
  return listeners;
}

export function isWriting(draftId: string): boolean {
  return runners.has(draftId);
}

export function subscribeWriting(draftId: string, listener: Listener): () => void {
  const listeners = listenersFor(draftId);
  listeners.add(listener);
  const live = liveByDraft.get(draftId);
  if (live) listener(live);
  return () => {
    // Keep the set: a runner in progress holds this same Set, so a page that returns
    // during the run must keep receiving its updates. One empty Set per visited draft.
    listeners.delete(listener);
  };
}

// Shell-level view of every run in this tab, used by the completion notice. It only
// forwards the updates the per-draft listeners already get; it never replays a stored
// state, so a page load or a reopened draft hears nothing.
export type AnyWriteListener = (draftId: string, live: WriteLive) => void;

const anyListeners = new Set<AnyWriteListener>();

export function subscribeAnyWriting(listener: AnyWriteListener): () => void {
  anyListeners.add(listener);
  return () => {
    anyListeners.delete(listener);
  };
}

export function stopWriting(draftId: string): void {
  const runner = runners.get(draftId);
  if (runner) runner.stop.stopped = true;
}

// Best-effort check before an automatic start. If the API is unavailable, startWriting
// still returns its own "another tab" message when the lock is held.
export async function draftWriteLockHeld(draftId: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks?.query) return false;
  try {
    const { held } = await navigator.locks.query();
    return Boolean(held?.some((lock) => lock.name === `draft:${draftId}`));
  } catch {
    return false;
  }
}

export interface StartWritingResult {
  ok: boolean;
  locked?: boolean;
  message?: string;
}

export async function startWriting(
  db: DrafterDBHandle,
  draft: DraftRecord,
  opts: { forceItemIds?: string[]; onlyItemIds?: string[] } = {},
): Promise<StartWritingResult> {
  if (runners.has(draft.id)) return { ok: true };

  const runner: Runner = { stop: { stopped: false }, listeners: listenersFor(draft.id) };
  runners.set(draft.id, runner);

  let live: WriteLive = {
    clauses: draft.clauses,
    run: draft.writeRun,
    writing: 0,
    active: true,
  };
  const emit = (next: Partial<WriteLive>) => {
    live = { ...live, ...next };
    liveByDraft.set(draft.id, live);
    for (const listener of runner.listeners) {
      // One UI listener throwing must not leave a stale runner entry behind.
      try {
        listener(live);
      } catch {
        // The run continues; the next update or a reload will re-sync the page.
      }
    }
    for (const listener of anyListeners) {
      try {
        listener(draft.id, live);
      } catch {
        // A shell listener can never disturb the run.
      }
    }
  };

  try {
    emit({});
    const { functionsUrl, anonKey } = functionsEndpoint();
    const locked = await runWithDraftLock(draft.id, async () => {
      await runWriting({
        db,
        draft,
        model: DRAFTER_WRITE_MODEL,
        maxTokens: DRAFTER_WRITE_MAX_TOKENS,
        concurrency: DRAFTER_CONCURRENCY,
        call: async (messages) => {
          emit({ writing: live.writing + 1 });
          try {
            return await writeSection(
              {
                functionsUrl,
                anonKey,
                getToken: freshToken,
                model: DRAFTER_WRITE_MODEL,
                maxTokens: DRAFTER_WRITE_MAX_TOKENS,
              },
              messages,
            );
          } finally {
            emit({ writing: Math.max(0, live.writing - 1) });
          }
        },
        onUpdate: (update) => {
          emit({
            clauses: update.clauses,
            run: update.run,
            active: !update.run.finishedAt,
          });
        },
        stop: runner.stop,
        forceItemIds: opts.forceItemIds,
        onlyItemIds: opts.onlyItemIds,
        sync: () => {
          void syncDraftById(supabase, db, draft.id);
        },
      });
    });

    if (!locked.ran) {
      return { ok: false, locked: true, message: 'This draft is already being written in another tab.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    emit({ writing: 0, active: false });
    if (runners.get(draft.id) === runner) runners.delete(draft.id);
    if (liveByDraft.get(draft.id) === live) liveByDraft.delete(draft.id);
  }
}
