import { supabase } from '../../lib/supabase';
import { freshToken, functionsEndpoint } from '../analysis/runtime';
import { DRAFTER_PLAN_MAX_TOKENS, DRAFTER_PLAN_MODEL } from '../../drafter/config';
import { buildDocAliases, type DocAlias, type PlanDoc } from '../../drafter/plan';
import { runPlanCall } from '../../drafter/planCall';
import { updateDraft, type DrafterDBHandle } from '../../drafter/store';
import { syncDraftById } from '../../drafter/sync';
import type { LibraryEntry } from '../../drafter/references';
import type { DraftRecord } from '../../drafter/types';

// Wires the one-off plan call for the UI. The call itself is in src/drafter/planCall.ts.

export function planDocsForDraft(draft: DraftRecord, library: LibraryEntry[]): DocAlias[] {
  const byId = new Map(library.map((doc) => [doc.id, doc]));
  const docs: PlanDoc[] = draft.referenceDocIds.map((id) => {
    const doc = byId.get(id);
    if (!doc) return { refDocId: id, name: null, pageCount: null, available: false };
    return {
      refDocId: id,
      name: doc.name,
      pageCount: doc.pageCount > 0 ? doc.pageCount : null,
      available: true,
    };
  });
  return buildDocAliases(docs);
}

// The raw reply is kept on this device only, for diagnosing a bad parse. It is never synced.
const rawKey = (draftId: string) => `legal-app.draft.${draftId}.planRaw`;
const RAW_LIMIT = 200_000;

export function savePlanRaw(draftId: string, raw: string): void {
  try {
    localStorage.setItem(rawKey(draftId), raw.slice(0, RAW_LIMIT));
  } catch {
    // Storage can be unavailable (private mode); the parse still works.
  }
}

export function readPlanRaw(draftId: string): string | null {
  try {
    return localStorage.getItem(rawKey(draftId));
  } catch {
    return null;
  }
}

export interface ParseOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  dropped: number;
  raw: string;
}

// Runs the parse and, on success, replaces the stored plan and particulars. The status stays
// 'brief' (a re-parse invalidates an earlier confirmation). Failures leave the draft untouched.
export async function parsePlanForDraft(
  db: DrafterDBHandle,
  draft: DraftRecord,
  library: LibraryEntry[],
): Promise<ParseOutcome> {
  const docs = planDocsForDraft(draft, library);
  const { functionsUrl, anonKey } = functionsEndpoint();
  const result = await runPlanCall(
    {
      functionsUrl,
      anonKey,
      getToken: freshToken,
      model: DRAFTER_PLAN_MODEL,
      maxTokens: DRAFTER_PLAN_MAX_TOKENS,
    },
    draft,
    docs,
  );
  savePlanRaw(draft.id, result.raw);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message, dropped: 0, raw: result.raw };
  }
  await updateDraft(db, draft.id, {
    sourcePlan: result.plan,
    particulars: result.particulars,
    status: 'brief',
  });
  void syncDraftById(supabase, db, draft.id);
  return { ok: true, dropped: result.dropped, raw: result.raw };
}
