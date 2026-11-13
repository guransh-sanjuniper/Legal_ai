import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatRole } from './thread';

// Persistence for chat sessions and messages. Every query runs as the signed-in user; row level
// security (migration 0004) limits the rows to that user's sessions.

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
}

const SESSION_COLUMNS = 'id,title,created_at,updated_at';
const MESSAGE_COLUMNS = 'id,session_id,role,content,created_at';

const toSession = (row: SessionRow): ChatSession => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toMessage = (row: MessageRow): ChatMessage => ({
  id: row.id,
  sessionId: row.session_id,
  role: row.role,
  content: row.content,
  createdAt: row.created_at,
});

function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export async function listSessions(db: SupabaseClient): Promise<ChatSession[]> {
  const rows = check(
    await db.from('chat_sessions').select(SESSION_COLUMNS).order('updated_at', { ascending: false }),
  ) as SessionRow[] | null;
  return (rows ?? []).map(toSession);
}

export async function createSession(db: SupabaseClient, userId: string, title: string): Promise<ChatSession> {
  const row = check(
    await db.from('chat_sessions').insert({ user_id: userId, title }).select(SESSION_COLUMNS).single(),
  ) as SessionRow;
  return toSession(row);
}

export async function loadSession(db: SupabaseClient, sessionId: string): Promise<ChatSession | null> {
  const row = check(
    await db.from('chat_sessions').select(SESSION_COLUMNS).eq('id', sessionId).maybeSingle(),
  ) as SessionRow | null;
  return row ? toSession(row) : null;
}

export async function loadMessages(db: SupabaseClient, sessionId: string): Promise<ChatMessage[]> {
  const rows = check(
    await db
      .from('chat_messages')
      .select(MESSAGE_COLUMNS)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true }),
  ) as MessageRow[] | null;
  return (rows ?? []).map(toMessage);
}

// Saves one message right away and moves its session to the top of the list.
export async function appendMessage(
  db: SupabaseClient,
  sessionId: string,
  role: ChatRole,
  content: string,
): Promise<ChatMessage> {
  const row = check(
    await db
      .from('chat_messages')
      .insert({ session_id: sessionId, role, content })
      .select(MESSAGE_COLUMNS)
      .single(),
  ) as MessageRow;
  check(await db.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId));
  return toMessage(row);
}

// Messages are removed with their session (foreign key cascade).
export async function deleteSession(db: SupabaseClient, sessionId: string): Promise<void> {
  check(await db.from('chat_sessions').delete().eq('id', sessionId));
}
