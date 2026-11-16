import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DRAFTER_DB_NAME,
  createDraft,
  deleteDraft,
  getDraft,
  listDeletions,
  openDrafterDb,
  updateDraft,
  type DrafterDBHandle,
} from './store';
import { draftToRow, pushDraft, removeDraftEverywhere, rowToDraft, syncDrafts, type DraftRow } from './sync';

// In-memory stand-in for the subset of the supabase-js query builder the sync uses.
type Row = Record<string, unknown>;

function fakeSupabase() {
  const tables: Record<string, Row[]> = { drafts: [] };
  const state = { failWrites: false, failReads: false, failDeletes: false };

  const db = {
    from(table: string) {
      const st = {
        op: 'select' as 'select' | 'upsert' | 'delete',
        payload: null as Row | null,
        filters: [] as [string, unknown][],
        order: null as null | { col: string; asc: boolean },
      };
      const run = () => {
        const rows = tables[table] ?? (tables[table] = []);
        const matches = (row: Row) => st.filters.every(([col, value]) => row[col] === value);

        if (st.op === 'upsert') {
          if (state.failWrites) return { data: null, error: { message: 'offline' } };
          const payload = { ...(st.payload ?? {}) };
          const index = rows.findIndex((row) => row.id === payload.id);
          if (index >= 0) rows[index] = { ...rows[index], ...payload };
          else rows.push(payload);
          return { data: null, error: null };
        }
        if (st.op === 'delete') {
          if (state.failDeletes) return { data: null, error: { message: 'offline' } };
          tables[table] = rows.filter((row) => !matches(row));
          return { data: null, error: null };
        }
        if (state.failReads) return { data: null, error: { message: 'offline' } };

        let out = rows.filter(matches).map((row) => ({ ...row }));
        if (st.order) {
          const { col, asc } = st.order;
          out = out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        return { data: out, error: null };
      };

      const builder = {
        select: () => builder,
        upsert(payload: Row) {
          st.op = 'upsert';
          st.payload = payload;
          return builder;
        },
        delete() {
          st.op = 'delete';
          return builder;
        },
        eq(col: string, value: unknown) {
          st.filters.push([col, value]);
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          st.order = { col, asc: opts?.ascending !== false };
          return builder;
        },
        then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  return { db: db as unknown as SupabaseClient, tables, state };
}

function row(over: Partial<DraftRow> = {}): Row {
  return {
    id: 'remote-a',
    user_id: 'user-a',
    title: 'Remote draft',
    instruction: 'Remote instruction',
    reference_doc_ids: [],
    reviewing_for: 'neutral',
    status: 'brief',
    data: { particulars: null, sourcePlan: null, outline: null, clauses: {} },
    schema_version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

describe('drafter sync', () => {
  let db: DrafterDBHandle;

  beforeEach(async () => {
    await deleteDB(DRAFTER_DB_NAME);
    db = await openDrafterDb();
  });

  afterEach(async () => {
    db.close();
    await deleteDB(DRAFTER_DB_NAME);
  });

  it('leaves the local draft untouched when the push fails, without throwing', async () => {
    const { db: client, state } = fakeSupabase();
    state.failWrites = true;

    const draft = await createDraft(db, { userId: 'user-a', instruction: 'Draft a sale deed.' });
    const before = await getDraft(db, draft.id);

    expect(await pushDraft(client, db, draft)).toBe(false);
    expect(await getDraft(db, draft.id)).toEqual(before);
    expect((await getDraft(db, draft.id))?.syncedAt).toBeUndefined();
  });

  it('keeps local data when the whole sync fails', async () => {
    const { db: client, state } = fakeSupabase();
    state.failWrites = true;
    state.failReads = true;

    const draft = await createDraft(db, { userId: 'user-a', instruction: 'Draft a lease.' });
    await expect(syncDrafts(client, db, 'user-a')).resolves.toEqual({ pulled: 0, pushed: 0, deleted: 0 });
    expect(await getDraft(db, draft.id)).toEqual(draft);
  });

  it('pushes a pending draft and marks it synced', async () => {
    const { db: client, tables } = fakeSupabase();
    const draft = await createDraft(db, {
      userId: 'user-a',
      instruction: 'Draft a lease.',
      referenceDocIds: ['doc-a'],
    });

    await expect(syncDrafts(client, db, 'user-a')).resolves.toEqual({ pulled: 0, pushed: 1, deleted: 0 });

    const stored = await getDraft(db, draft.id);
    expect(stored?.syncedAt).toBe(stored?.updatedAt);
    const remote = tables.drafts.find((candidate) => candidate.id === draft.id);
    expect(remote?.user_id).toBe('user-a');
    expect(remote?.reference_doc_ids).toEqual(['doc-a']);
    expect(remote?.instruction).toBe('Draft a lease.');
  });

  it('pulls only drafts missing locally and never overwrites a local draft', async () => {
    const { db: client, tables } = fakeSupabase();
    const local = await createDraft(db, { userId: 'user-a', instruction: 'Local instruction' });

    tables.drafts.push(row({ id: local.id, instruction: 'Remote edit', updated_at: '2026-01-05T00:00:00.000Z' }));
    tables.drafts.push(row({ id: 'remote-b', title: 'Remote B', updated_at: '2026-01-03T00:00:00.000Z' }));

    const result = await syncDrafts(client, db, 'user-a');
    expect(result.pulled).toBe(1);

    // Local wins for a draft that is already here.
    expect((await getDraft(db, local.id))?.instruction).toBe('Local instruction');

    const pulled = await getDraft(db, 'remote-b');
    expect(pulled?.title).toBe('Remote B');
    expect(pulled?.syncedAt).toBe('2026-01-03T00:00:00.000Z');
    expect(pulled?.schemaVersion).toBe(1);
  });

  it('does not pull back a draft that was deleted here', async () => {
    const { db: client, tables, state } = fakeSupabase();
    const draft = await createDraft(db, { userId: 'user-a', instruction: 'Delete me' });
    tables.drafts.push(row({ id: draft.id, user_id: 'user-a' }));

    await deleteDraft(db, draft.id);
    state.failDeletes = true;

    await syncDrafts(client, db, 'user-a');
    expect(await getDraft(db, draft.id)).toBeNull();
    expect((await listDeletions(db)).map((deletion) => deletion.id)).toEqual([draft.id]);

    // Once the remote delete can be sent, the tombstone is cleared.
    state.failDeletes = false;
    const result = await syncDrafts(client, db, 'user-a');
    expect(result.deleted).toBe(1);
    expect(tables.drafts.some((candidate) => candidate.id === draft.id)).toBe(false);
    expect(await listDeletions(db)).toEqual([]);
  });

  it('removes a draft locally even when the remote delete fails', async () => {
    const { db: client, state } = fakeSupabase();
    const draft = await createDraft(db, { userId: 'user-a', instruction: 'Delete me' });
    state.failDeletes = true;

    await expect(removeDraftEverywhere(client, db, draft.id)).resolves.toBe(true);
    expect(await getDraft(db, draft.id)).toBeNull();
    expect(await listDeletions(db)).toHaveLength(1);
  });

  it('is a no-op without a Supabase client', async () => {
    const draft = await createDraft(db, { userId: 'user-a', instruction: 'Offline draft' });
    await expect(syncDrafts(null, db, 'user-a')).resolves.toEqual({ pulled: 0, pushed: 0, deleted: 0 });
    expect(await getDraft(db, draft.id)).toEqual(draft);
  });

  it('tolerates an incomplete remote row', () => {
    const converted = rowToDraft({
      id: 'remote-c',
      user_id: 'user-a',
      title: null,
      instruction: null,
      reference_doc_ids: null,
      reviewing_for: 'both',
      status: 'brief',
      data: null,
      schema_version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    } as unknown as DraftRow);

    expect(converted.title).toBe('');
    expect(converted.instruction).toBe('');
    expect(converted.referenceDocIds).toEqual([]);
    expect(converted.reviewingFor).toBe('neutral');
    expect(converted.clauses).toEqual({});
    expect(converted.particulars).toBeNull();
    expect(converted.sourcePlan).toBeNull();
    expect(converted.outline).toBeNull();
  });

  it('loads a D1 row with no plan and no particulars', () => {
    const converted = rowToDraft({
      id: 'remote-d1',
      user_id: 'user-a',
      title: 'Old draft',
      instruction: 'Draft a lease.',
      reference_doc_ids: [],
      reviewing_for: 'neutral',
      status: 'brief',
      data: { particulars: null, sourcePlan: null, outline: null, clauses: {} },
      schema_version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    } as unknown as DraftRow);

    expect(converted.particulars).toBeNull();
    expect(converted.sourcePlan).toBeNull();
    expect(converted.status).toBe('brief');
  });

  it('round-trips a D2 plan and particulars through the row mapping', async () => {
    const created = await createDraft(db, { userId: 'user-a', instruction: 'Draft a lease.' });
    const plan = {
      docType: 'lease',
      summary: 'A lease.',
      lengthHint: null,
      referenceMode: 'general' as const,
      bindings: [],
      unresolved: [],
      questions: ['Who are the parties?'],
      parsedAt: '2026-01-02T00:00:00.000Z',
      model: 'test-model',
      parsedFrom: { instruction: 'Draft a lease.', referenceDocIds: [] },
    };
    const particulars = [
      { id: 'p1', label: 'Deposit', kind: 'amount' as const, value: null, source: 'instruction' as const, required: true },
    ];
    const updated = await updateDraft(db, created.id, { sourcePlan: plan, particulars });

    const converted = rowToDraft(draftToRow(updated));
    expect(converted.sourcePlan).toEqual(plan);
    expect(converted.particulars).toEqual(particulars);
    expect(converted.status).toBe('brief');
    expect(converted.syncedAt).toBe(updated.updatedAt);
  });

  it('round-trips an outline and drops a malformed one', async () => {
    const created = await createDraft(db, { userId: 'user-a', instruction: 'Draft a lease.' });
    const outline = {
      items: [
        { id: 'o1', level: 1 as const, title: 'Parties', purpose: 'Who the lease is between', kind: 'preamble' as const, bindingIds: [] },
      ],
      notes: 'Short.',
      createdAt: '2026-01-02T00:00:00.000Z',
      model: 'outline-model',
      planFingerprint: '0123456789abcdef',
    };
    const updated = await updateDraft(db, created.id, { outline });

    const converted = rowToDraft(draftToRow(updated));
    expect(converted.outline).toEqual(outline);

    const malformed = rowToDraft({
      ...draftToRow(updated),
      data: { outline: { nope: true } },
    } as unknown as DraftRow);
    expect(malformed.outline).toBeNull();
  });
});
