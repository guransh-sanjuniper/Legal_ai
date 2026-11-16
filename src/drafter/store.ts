import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { deriveTitle, titleOrDerived } from './brief';
import {
  DRAFTER_SCHEMA_VERSION,
  DEFAULT_REVIEWING_FOR,
  type DraftDeletion,
  type DraftPatch,
  type DraftRecord,
  type NewDraftInput,
} from './types';

// The Drafter has its own database. `pipeline-harness` (documents, pages, chunks, tasks) is
// never touched: its name, version and stores stay as they are. Plain TypeScript, so later
// runner stages can reuse the same store.
export const DRAFTER_DB_NAME = 'legal-drafter';
export const DRAFTER_DB_VERSION = 1;

interface DrafterDB extends DBSchema {
  drafts: { key: string; value: DraftRecord; indexes: { byUser: string } };
  draft_deletions: { key: string; value: DraftDeletion };
}

export type DrafterDBHandle = IDBPDatabase<DrafterDB>;

export function openDrafterDb(): Promise<DrafterDBHandle> {
  return openDB<DrafterDB>(DRAFTER_DB_NAME, DRAFTER_DB_VERSION, {
    upgrade(db) {
      const drafts = db.createObjectStore('drafts', { keyPath: 'id' });
      drafts.createIndex('byUser', 'userId');
      db.createObjectStore('draft_deletions', { keyPath: 'id' });
    },
  });
}

function newDraftId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function uniqueIds(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export async function createDraft(db: DrafterDBHandle, input: NewDraftInput): Promise<DraftRecord> {
  const now = new Date().toISOString();
  const draft: DraftRecord = {
    id: newDraftId(),
    userId: input.userId,
    title: titleOrDerived(input.title ?? '', input.instruction),
    instruction: input.instruction,
    referenceDocIds: uniqueIds(input.referenceDocIds ?? []),
    reviewingFor: input.reviewingFor ?? DEFAULT_REVIEWING_FOR,
    status: 'brief',
    particulars: null,
    sourcePlan: null,
    outline: null,
    sourceText: null,
    clauses: {},
    writeRun: null,
    schemaVersion: DRAFTER_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
  };
  await db.put('drafts', draft);
  return draft;
}

export async function getDraft(db: DrafterDBHandle, id: string): Promise<DraftRecord | null> {
  return (await db.get('drafts', id)) ?? null;
}

// Most recently updated first. Drafts are per user: a different account on the same device
// never sees another account's drafts.
export async function listDrafts(db: DrafterDBHandle, userId: string): Promise<DraftRecord[]> {
  const rows = await db.getAllFromIndex('drafts', 'byUser', userId);
  return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export async function updateDraft(db: DrafterDBHandle, id: string, patch: DraftPatch): Promise<DraftRecord> {
  const tx = db.transaction('drafts', 'readwrite');
  const store = tx.objectStore('drafts');
  const current = await store.get(id);
  if (!current) {
    await tx.done;
    throw new Error(`Draft ${id} not found`);
  }

  const {
    title,
    instruction,
    referenceDocIds,
    reviewingFor,
    status,
    particulars,
    sourcePlan,
    outline,
    sourceText,
    clauses,
    writeRun,
  } = patch;

  const next: DraftRecord = {
    ...current,
    title: title !== undefined ? title : current.title,
    instruction: instruction !== undefined ? instruction : current.instruction,
    referenceDocIds: referenceDocIds !== undefined ? uniqueIds(referenceDocIds) : current.referenceDocIds,
    reviewingFor: reviewingFor !== undefined ? reviewingFor : current.reviewingFor,
    status: status !== undefined ? status : current.status,
    particulars: particulars !== undefined ? particulars : current.particulars,
    sourcePlan: sourcePlan !== undefined ? sourcePlan : current.sourcePlan,
    outline: outline !== undefined ? outline : current.outline,
    sourceText: sourceText !== undefined ? sourceText : current.sourceText,
    clauses: clauses !== undefined ? clauses : current.clauses,
    writeRun: writeRun !== undefined ? writeRun : current.writeRun,
    updatedAt: new Date().toISOString(),
  };
  // A blank title is always replaced by the start of the instruction. A title that was itself
  // derived from the old instruction follows the new one; a title the user typed is kept.
  if (title === undefined && current.title === deriveTitle(current.instruction)) {
    next.title = deriveTitle(next.instruction);
  }
  next.title = titleOrDerived(next.title, next.instruction);

  await store.put(next);
  await tx.done;
  return next;
}

// Local removal plus a tombstone. The tombstone keeps a later pull from bringing the draft
// back when the remote delete could not be sent (offline, signed out).
export async function deleteDraft(db: DrafterDBHandle, id: string): Promise<void> {
  const tx = db.transaction(['drafts', 'draft_deletions'], 'readwrite');
  const current = await tx.objectStore('drafts').get(id);
  await tx.objectStore('drafts').delete(id);
  if (current) {
    const deletion: DraftDeletion = { id, userId: current.userId, deletedAt: new Date().toISOString() };
    await tx.objectStore('draft_deletions').put(deletion);
  }
  await tx.done;
}

export async function getDeletion(db: DrafterDBHandle, id: string): Promise<DraftDeletion | null> {
  return (await db.get('draft_deletions', id)) ?? null;
}

export async function listDeletions(db: DrafterDBHandle): Promise<DraftDeletion[]> {
  return db.getAll('draft_deletions');
}

export async function clearDeletion(db: DrafterDBHandle, id: string): Promise<void> {
  await db.delete('draft_deletions', id);
}
