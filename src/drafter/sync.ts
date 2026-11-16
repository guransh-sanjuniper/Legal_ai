import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReviewingFor } from '../analysis/types';
import {
  clearDeletion,
  deleteDraft,
  getDeletion,
  listDeletions,
  type DrafterDBHandle,
} from './store';
import { normaliseStoredParticulars, normaliseStoredPlan } from './plan';
import { normaliseStoredOutline } from './outline';
import { normaliseStoredSourceText, sourceTextForSync } from './resolveRef';
import { normaliseStoredClauses, normaliseStoredWriteRun } from './write';
import { DRAFTER_SCHEMA_VERSION, type DraftRecord, type DraftStatus } from './types';

// Local-first sync for drafts. IndexedDB is the working copy; Supabase is the backup and the
// way a draft reaches another device. Every call here is best effort: a network, auth or
// schema failure returns a falsy result and never throws to the UI.
//
// D1 conflict rule: local wins. A pull only inserts drafts that are missing locally, so an
// edit made on another device to a draft already on this device is not merged (deferred).
// Rows are whole-record upserts keyed by id, so the last push wins.

export interface DraftRow {
  id: string;
  user_id: string;
  title: string;
  instruction: string;
  reference_doc_ids: string[];
  reviewing_for: ReviewingFor;
  status: DraftStatus;
  data: {
    particulars: unknown;
    sourcePlan: unknown;
    outline: unknown;
    sourceText?: unknown;
    clauses: unknown;
    writeRun?: unknown;
  };
  schema_version: number;
  created_at: string;
  updated_at: string;
}

const DRAFT_COLUMNS =
  'id,user_id,title,instruction,reference_doc_ids,reviewing_for,status,data,schema_version,created_at,updated_at';

export function draftToRow(draft: DraftRecord): DraftRow {
  return {
    id: draft.id,
    user_id: draft.userId,
    title: draft.title,
    instruction: draft.instruction,
    reference_doc_ids: draft.referenceDocIds,
    reviewing_for: draft.reviewingFor,
    status: draft.status,
    data: {
      particulars: draft.particulars,
      sourcePlan: draft.sourcePlan,
      outline: draft.outline,
      sourceText: sourceTextForSync(draft.sourceText),
      clauses: draft.clauses,
      writeRun: draft.writeRun,
    },
    schema_version: DRAFTER_SCHEMA_VERSION,
    created_at: draft.createdAt,
    updated_at: draft.updatedAt,
  };
}

function reviewingForOf(value: unknown): ReviewingFor {
  if (value === 'licensor' || value === 'licensee' || value === 'neutral') return value;
  return 'neutral';
}

// Tolerant of nulls and older rows: a field that is missing gets a safe default instead of
// failing the whole pull.
export function rowToDraft(row: DraftRow): DraftRecord {
  const data = (row.data ?? {}) as Partial<DraftRow['data']>;
  return {
    id: row.id,
    userId: row.user_id,
    title: typeof row.title === 'string' ? row.title : '',
    instruction: typeof row.instruction === 'string' ? row.instruction : '',
    referenceDocIds: Array.isArray(row.reference_doc_ids)
      ? row.reference_doc_ids.filter((id): id is string => typeof id === 'string')
      : [],
    reviewingFor: reviewingForOf(row.reviewing_for),
    status: typeof row.status === 'string' ? (row.status as DraftStatus) : 'brief',
    particulars: normaliseStoredParticulars(data.particulars),
    sourcePlan: normaliseStoredPlan(data.sourcePlan),
    outline: normaliseStoredOutline(data.outline),
    sourceText: normaliseStoredSourceText(data.sourceText),
    clauses: normaliseStoredClauses(data.clauses),
    writeRun: normaliseStoredWriteRun(data.writeRun),
    schemaVersion: DRAFTER_SCHEMA_VERSION,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.updated_at,
  };
}

// Records that this exact version reached Supabase. A newer local edit (a different
// updatedAt) is left pending.
async function markSynced(db: DrafterDBHandle, draft: DraftRecord): Promise<void> {
  const current = await db.get('drafts', draft.id);
  if (!current || current.updatedAt !== draft.updatedAt) return;
  if (current.syncedAt === current.updatedAt) return;
  await db.put('drafts', { ...current, syncedAt: current.updatedAt });
}

export async function pushDraft(
  client: SupabaseClient | null,
  db: DrafterDBHandle,
  draft: DraftRecord,
): Promise<boolean> {
  if (!client) return false;
  try {
    const { error } = await client.from('drafts').upsert(draftToRow(draft), { onConflict: 'id' });
    if (error) return false;
    await markSynced(db, draft);
    return true;
  } catch {
    return false;
  }
}

// Called after an explicit Save. The save is already durable locally.
export async function syncDraftById(
  client: SupabaseClient | null,
  db: DrafterDBHandle,
  id: string,
): Promise<boolean> {
  try {
    const draft = await db.get('drafts', id);
    if (!draft) return false;
    return await pushDraft(client, db, draft);
  } catch {
    return false;
  }
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  deleted: number;
}

// Runs on /draft load: flush pending deletes, pull drafts missing on this device, retry
// pending pushes. A failure at any step leaves local data as it was.
export async function syncDrafts(
  client: SupabaseClient | null,
  db: DrafterDBHandle,
  userId: string,
): Promise<SyncResult> {
  const result: SyncResult = { pulled: 0, pushed: 0, deleted: 0 };
  if (!client || !userId) return result;

  try {
    for (const deletion of await listDeletions(db)) {
      try {
        const { error } = await client
          .from('drafts')
          .delete()
          .eq('id', deletion.id)
          .eq('user_id', deletion.userId);
        if (!error) {
          await clearDeletion(db, deletion.id);
          result.deleted++;
        }
      } catch {
        // Retried on the next save or page load.
      }
    }
  } catch {
    // IndexedDB unavailable; the pull below still tries.
  }

  try {
    const { data, error } = await client
      .from('drafts')
      .select(DRAFT_COLUMNS)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (!error && Array.isArray(data)) {
      const tombstones = new Set((await listDeletions(db)).map((deletion) => deletion.id));
      for (const row of data as unknown as DraftRow[]) {
        if (tombstones.has(row.id)) continue;
        if (await db.get('drafts', row.id)) continue;
        await db.put('drafts', rowToDraft(row));
        result.pulled++;
      }
    }
  } catch {
    // Offline or RLS denied: local drafts stay as they are.
  }

  try {
    for (const draft of await db.getAllFromIndex('drafts', 'byUser', userId)) {
      if (draft.syncedAt === draft.updatedAt) continue;
      if (await pushDraft(client, db, draft)) result.pushed++;
    }
  } catch {
    // Retried on the next save or page load.
  }

  return result;
}

// Deletes locally first (and writes the tombstone), then tries the remote row. The return
// value reports the local removal; a pending remote delete is retried on the next load.
export async function removeDraftEverywhere(
  client: SupabaseClient | null,
  db: DrafterDBHandle,
  id: string,
): Promise<boolean> {
  try {
    await deleteDraft(db, id);
  } catch {
    return false;
  }

  if (!client) return true;
  try {
    const deletion = await getDeletion(db, id);
    if (!deletion) return true;
    const { error } = await client
      .from('drafts')
      .delete()
      .eq('id', id)
      .eq('user_id', deletion.userId);
    if (!error) await clearDeletion(db, id);
  } catch {
    // The tombstone keeps the draft from coming back on the next pull.
  }
  return true;
}
