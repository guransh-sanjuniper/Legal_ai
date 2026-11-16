import { supabase } from '../../lib/supabase';
import { freshToken, functionsEndpoint } from '../analysis/runtime';
import { DRAFTER_OUTLINE_MAX_TOKENS, DRAFTER_OUTLINE_MODEL } from '../../drafter/config';
import { runOutlineCall } from '../../drafter/outlineCall';
import { loadRefStructures, type RefStructure } from '../../drafter/refStructure';
import { updateDraft, type DrafterDBHandle } from '../../drafter/store';
import { syncDraftById } from '../../drafter/sync';
import { openHarnessDb } from '../../runner/db';
import type { LibraryEntry } from '../../drafter/references';
import type { DraftRecord, Outline } from '../../drafter/types';
import { planDocsForDraft } from './planRun';

// Wires one outline call for the UI. The call itself is in src/drafter/outlineCall.ts.

const rawKey = (draftId: string) => `legal-app.draft.${draftId}.outlineRaw`;
const RAW_LIMIT = 300_000;

export function saveOutlineRaw(draftId: string, raw: string): void {
  try {
    localStorage.setItem(rawKey(draftId), raw.slice(0, RAW_LIMIT));
  } catch {
    // Storage can be unavailable (private mode); the call still works.
  }
}

export function readOutlineRaw(draftId: string): string | null {
  try {
    return localStorage.getItem(rawKey(draftId));
  } catch {
    return null;
  }
}

export interface OutlineOutcome {
  ok: boolean;
  message?: string;
  dropped: number;
  duplicates: string[];
  raw: string;
}

// Makes the outline and stores it on the draft. The draft status is not changed here: only the
// user's confirmation on the outline screen writes 'outlined'.
export async function generateOutline(
  db: DrafterDBHandle,
  draft: DraftRecord,
  library: LibraryEntry[],
  opts: { feedback?: string; previous?: Outline | null } = {},
): Promise<OutlineOutcome> {
  const plan = draft.sourcePlan;
  if (!plan) {
    return { ok: false, message: 'Confirm the plan first.', dropped: 0, duplicates: [], raw: '' };
  }

  const docs = planDocsForDraft(draft, library);
  let structures: RefStructure[] = [];
  try {
    // Read-only heading hints for general/style references.
    const harness = await openHarnessDb();
    structures = (await loadRefStructures(harness, docs, plan.bindings)).structures;
  } catch {
    structures = [];
  }

  const { functionsUrl, anonKey } = functionsEndpoint();
  const result = await runOutlineCall(
    {
      functionsUrl,
      anonKey,
      getToken: freshToken,
      model: DRAFTER_OUTLINE_MODEL,
      maxTokens: DRAFTER_OUTLINE_MAX_TOKENS,
    },
    draft,
    docs,
    structures,
    opts.feedback,
    opts.previous,
  );

  saveOutlineRaw(draft.id, result.raw);
  if (!result.ok) {
    return { ok: false, message: result.message, dropped: 0, duplicates: [], raw: result.raw };
  }

  await updateDraft(db, draft.id, { outline: result.outline });
  void syncDraftById(supabase, db, draft.id);
  return { ok: true, dropped: result.dropped, duplicates: result.duplicates, raw: result.raw };
}
