import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveTitle } from './brief';
import {
  DRAFTER_DB_NAME,
  clearDeletion,
  createDraft,
  deleteDraft,
  getDraft,
  listDeletions,
  listDrafts,
  openDrafterDb,
  updateDraft,
  type DrafterDBHandle,
} from './store';

const BASE = Date.parse('2026-01-01T00:00:00.000Z');

function at(seconds: number): void {
  vi.setSystemTime(new Date(BASE + seconds * 1000));
}

describe('drafter store', () => {
  let db: DrafterDBHandle;

  beforeEach(async () => {
    // Only Date is faked: fake-indexeddb still needs the real task queue.
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    await deleteDB(DRAFTER_DB_NAME);
    db = await openDrafterDb();
  });

  afterEach(async () => {
    db.close();
    await deleteDB(DRAFTER_DB_NAME);
    vi.useRealTimers();
  });

  it('creates a brief with the D1 defaults and reads it back', async () => {
    const draft = await createDraft(db, { userId: 'user-a', instruction: 'Draft a leave and licence for a flat in Pune.' });
    expect(draft.status).toBe('brief');
    expect(draft.reviewingFor).toBe('neutral');
    expect(draft.referenceDocIds).toEqual([]);
    expect(draft.particulars).toBeNull();
    expect(draft.sourcePlan).toBeNull();
    expect(draft.outline).toBeNull();
    expect(draft.clauses).toEqual({});
    expect(draft.schemaVersion).toBe(1);
    expect(draft.createdAt).toBe(draft.updatedAt);
    expect(await getDraft(db, draft.id)).toEqual(draft);
  });

  it('derives a title from the instruction when the title is blank', async () => {
    const instruction = 'Draft a commercial lease for a shop in Bandra with a five year term and a deposit.';
    const draft = await createDraft(db, { userId: 'user-a', instruction, title: '   ' });
    expect(draft.title).toBe(deriveTitle(instruction));
    expect(draft.title.length).toBeLessThanOrEqual(61);

    const named = await createDraft(db, { userId: 'user-a', instruction, title: 'Bandra shop lease' });
    expect(named.title).toBe('Bandra shop lease');
  });

  it('lists only the user’s drafts, most recently updated first', async () => {
    at(0);
    const first = await createDraft(db, { userId: 'user-a', instruction: 'First draft' });
    at(10);
    const second = await createDraft(db, { userId: 'user-a', instruction: 'Second draft' });
    at(20);
    await createDraft(db, { userId: 'user-b', instruction: 'Other user draft' });

    expect((await listDrafts(db, 'user-a')).map((draft) => draft.id)).toEqual([second.id, first.id]);
    expect((await listDrafts(db, 'user-b')).map((draft) => draft.instruction)).toEqual(['Other user draft']);
    expect(await listDrafts(db, 'user-c')).toEqual([]);
  });

  it('updates a draft, moves updatedAt and keeps the immutable fields', async () => {
    const draft = await createDraft(db, { userId: 'user-a', instruction: 'Old instruction' });
    at(30);
    const updated = await updateDraft(db, draft.id, {
      instruction: 'Draft a sale deed for a plot in Nashik.',
      referenceDocIds: ['doc-a', 'doc-b', 'doc-a'],
      reviewingFor: 'licensee',
    });

    expect(updated.id).toBe(draft.id);
    expect(updated.userId).toBe('user-a');
    expect(updated.createdAt).toBe(draft.createdAt);
    expect(updated.updatedAt).not.toBe(draft.updatedAt);
    expect(updated.updatedAt > draft.updatedAt).toBe(true);
    expect(updated.referenceDocIds).toEqual(['doc-a', 'doc-b']);
    expect(updated.reviewingFor).toBe('licensee');
    expect(updated.title).toBe(deriveTitle('Draft a sale deed for a plot in Nashik.'));
    expect(await getDraft(db, draft.id)).toEqual(updated);
  });

  it('re-derives the title when an update blanks it', async () => {
    const draft = await createDraft(db, { userId: 'user-a', instruction: 'Lease', title: 'Named' });
    const updated = await updateDraft(db, draft.id, { title: '', instruction: 'Licence agreement for a flat.' });
    expect(updated.title).toBe('Licence agreement for a flat.');
  });

  it('keeps a title the user typed when the instruction changes', async () => {
    const draft = await createDraft(db, { userId: 'user-a', instruction: 'Lease', title: 'Bandra shop lease' });
    const updated = await updateDraft(db, draft.id, { instruction: 'A completely different instruction.' });
    expect(updated.title).toBe('Bandra shop lease');
  });

  it('refuses to update a draft that is not on this device', async () => {
    await expect(updateDraft(db, 'missing', { instruction: 'x' })).rejects.toThrow(/not found/);
  });

  it('deletes the draft and leaves a tombstone', async () => {
    const draft = await createDraft(db, { userId: 'user-a', instruction: 'Remove me' });
    await deleteDraft(db, draft.id);

    expect(await getDraft(db, draft.id)).toBeNull();
    expect((await listDeletions(db)).map((deletion) => deletion.id)).toEqual([draft.id]);
    expect((await listDeletions(db))[0].userId).toBe('user-a');

    await clearDeletion(db, draft.id);
    expect(await listDeletions(db)).toEqual([]);
  });

  it('returns null for an unknown draft', async () => {
    expect(await getDraft(db, 'nope')).toBeNull();
  });
});
