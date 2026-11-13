import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  appendMessage,
  createSession,
  deleteSession,
  listSessions,
  loadMessages,
  loadSession,
} from './store';

// In-memory stand-in for the subset of the supabase-js query builder the store uses. It models
// the foreign key cascade from chat_messages to chat_sessions, which the real schema has.
type Row = Record<string, unknown>;

function fakeSupabase() {
  const tables: Record<string, Row[]> = { chat_sessions: [], chat_messages: [] };
  let seq = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + ++seq * 1000).toISOString();

  const db = {
    from(table: string) {
      const st = {
        op: 'select' as 'select' | 'insert' | 'update' | 'delete',
        payload: null as Row | null,
        filters: [] as [string, unknown][],
        order: null as null | { col: string; asc: boolean },
        single: null as null | 'one' | 'maybe',
      };
      const run = () => {
        const rows = tables[table];
        const matches = (r: Row) => st.filters.every(([c, v]) => r[c] === v);
        if (st.op === 'insert') {
          const row: Row = { id: `${table}-${++seq}`, created_at: stamp(), ...st.payload };
          if (table === 'chat_sessions') row.updated_at = row.created_at;
          if (table === 'chat_messages' && !tables.chat_sessions.some((s) => s.id === row.session_id)) {
            return { data: null, error: { message: 'foreign key violation' } };
          }
          rows.push(row);
          const copy = { ...row };
          return { data: st.single ? copy : [copy], error: null };
        }
        if (st.op === 'update') {
          rows.filter(matches).forEach((r) => Object.assign(r, st.payload));
          return { data: null, error: null };
        }
        if (st.op === 'delete') {
          const doomed = rows.filter(matches);
          tables[table] = rows.filter((r) => !matches(r));
          if (table === 'chat_sessions') {
            const gone = new Set(doomed.map((r) => r.id));
            tables.chat_messages = tables.chat_messages.filter((m) => !gone.has(m.session_id));
          }
          return { data: null, error: null };
        }
        let out = rows.filter(matches).map((r) => ({ ...r }));
        if (st.order) {
          const { col, asc } = st.order;
          out = out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        if (st.single) {
          const first = out[0] ?? null;
          if (st.single === 'one' && !first) return { data: null, error: { message: 'no rows' } };
          return { data: first, error: null };
        }
        return { data: out, error: null };
      };
      const builder = {
        select: () => builder,
        insert(p: Row) {
          st.op = 'insert';
          st.payload = p;
          return builder;
        },
        update(p: Row) {
          st.op = 'update';
          st.payload = p;
          return builder;
        },
        delete() {
          st.op = 'delete';
          return builder;
        },
        eq(col: string, v: unknown) {
          st.filters.push([col, v]);
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          st.order = { col, asc: opts?.ascending !== false };
          return builder;
        },
        single() {
          st.single = 'one';
          return builder;
        },
        maybeSingle() {
          st.single = 'maybe';
          return builder;
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, tables };
}

describe('chat persistence', () => {
  let db: SupabaseClient;
  let tables: Record<string, Row[]>;

  beforeEach(() => {
    ({ db, tables } = fakeSupabase());
  });

  it('creates a session and reads it back', async () => {
    const s = await createSession(db, 'user-a', 'Lease question');
    expect(s.title).toBe('Lease question');
    expect(await loadSession(db, s.id)).toEqual(s);
    expect(await loadSession(db, 'missing')).toBeNull();
  });

  it('saves messages in order and restores them', async () => {
    const s = await createSession(db, 'user-a', 'Hi');
    await appendMessage(db, s.id, 'user', 'Hi');
    await appendMessage(db, s.id, 'assistant', 'Hello');
    const msgs = await loadMessages(db, s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'Hello'],
    ]);
  });

  it('saves and restores the document context of a message', async () => {
    const s = await createSession(db, 'user-a', 'Lease');
    const cite = { page: 3, clause: '4', quote: 'a deposit of Rs 50,000' };
    await appendMessage(db, s.id, 'user', "what's the deposit?", { documentId: 'doc-1', documentName: 'Lease.pdf', mode: null, citations: null });
    await appendMessage(db, s.id, 'assistant', 'Rs 50,000.', { documentId: 'doc-1', documentName: 'Lease.pdf', mode: 'saved', citations: [cite] });
    await appendMessage(db, s.id, 'user', 'hello');
    const [q, a, general] = await loadMessages(db, s.id);
    expect([q.documentId, q.documentName]).toEqual(['doc-1', 'Lease.pdf']);
    expect([a.mode, a.citations]).toEqual(['saved', [cite]]);
    expect([general.documentId, general.documentName, general.mode, general.citations]).toEqual([null, null, null, null]);
  });

  it('lists sessions with the most recently updated first', async () => {
    const first = await createSession(db, 'user-a', 'First');
    const second = await createSession(db, 'user-a', 'Second');
    expect((await listSessions(db)).map((s) => s.id)).toEqual([second.id, first.id]);

    await appendMessage(db, first.id, 'user', 'more');
    expect((await listSessions(db)).map((s) => s.id)).toEqual([first.id, second.id]);
  });

  it('keeps each session thread separate', async () => {
    const a = await createSession(db, 'user-a', 'A');
    const b = await createSession(db, 'user-a', 'B');
    await appendMessage(db, a.id, 'user', 'about A');
    await appendMessage(db, b.id, 'user', 'about B');
    expect((await loadMessages(db, a.id)).map((m) => m.content)).toEqual(['about A']);
    expect((await loadMessages(db, b.id)).map((m) => m.content)).toEqual(['about B']);
  });

  it('deletes a session and its messages', async () => {
    const s = await createSession(db, 'user-a', 'Gone');
    await appendMessage(db, s.id, 'user', 'bye');
    await deleteSession(db, s.id);
    expect(await loadSession(db, s.id)).toBeNull();
    expect(await listSessions(db)).toEqual([]);
    expect(tables.chat_messages).toEqual([]);
  });

  it('refuses a message for a session that does not exist', async () => {
    await expect(appendMessage(db, 'nope', 'user', 'x')).rejects.toThrow(/foreign key/);
  });
});
