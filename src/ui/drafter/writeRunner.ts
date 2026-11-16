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
  run: WriteRun;
}

type Listener = (live: WriteLive) => void;

interface Runner {
  stop: { stopped: boolean };
  listeners: Set<Listener>;
}

const runners = new Map<string, Runner>();

export function isWriting(draftId: string): boolean {
  return runners.has(draftId);
}

export function subscribeWriting(draftId: string, listener: Listener): () => void {
  const runner = runners.get(draftId);
  if (!runner) return () => undefined;
  runner.listeners.add(listener);
  return () => {
    runner.listeners.delete(listener);
  };
}

export function stopWriting(draftId: string): void {
  const runner = runners.get(draftId);
  if (runner) runner.stop.stopped = true;
}

export interface StartWritingResult {
  ok: boolean;
  locked?: boolean;
  message?: string;
}

export async function startWriting(
  db: DrafterDBHandle,
  draft: DraftRecord,
  opts: { forceItemIds?: string[] } = {},
): Promise<StartWritingResult> {
  if (runners.has(draft.id)) return { ok: true };

  const runner: Runner = { stop: { stopped: false }, listeners: new Set() };
  runners.set(draft.id, runner);

  try {
    const { functionsUrl, anonKey } = functionsEndpoint();
    const locked = await runWithDraftLock(draft.id, async () => {
      await runWriting({
        db,
        draft,
        model: DRAFTER_WRITE_MODEL,
        maxTokens: DRAFTER_WRITE_MAX_TOKENS,
        concurrency: DRAFTER_CONCURRENCY,
        call: (messages) =>
          writeSection(
            {
              functionsUrl,
              anonKey,
              getToken: freshToken,
              model: DRAFTER_WRITE_MODEL,
              maxTokens: DRAFTER_WRITE_MAX_TOKENS,
            },
            messages,
          ),
        onUpdate: (live) => {
          for (const listener of runner.listeners) listener(live);
        },
        stop: runner.stop,
        forceItemIds: opts.forceItemIds,
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
    runners.delete(draft.id);
  }
}
