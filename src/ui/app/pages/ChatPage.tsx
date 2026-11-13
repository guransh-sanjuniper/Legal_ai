import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../AuthProvider';
import { freshToken, functionsEndpoint } from '../../analysis/runtime';
import { Markdown } from '../../chat/Markdown';
import { PageHeader } from './Placeholder';
import { CHAT_MAX_TOKENS, CHAT_MODEL } from '../../../chat/config';
import { describeChatError } from '../../../chat/errors';
import { ChatError, streamChat } from '../../../chat/stream';
import {
  appendMessage,
  createSession,
  deleteSession,
  listSessions,
  loadMessages,
  loadSession,
  type ChatMessage,
  type ChatSession,
} from '../../../chat/store';
import { buildRequestMessages, titleFrom } from '../../../chat/thread';

type Pending = { status: 'streaming'; content: string } | { status: 'error'; content: string; message: string };

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

function withUpdated(list: ChatSession[], id: string, at: string): ChatSession[] {
  return list
    .map((s) => (s.id === id ? { ...s, updatedAt: at } : s))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// General chat. The session is in the URL (/chat/:sessionId), so a reload restores it. Nothing
// here is document-aware: the request carries only the thread.
export function ChatPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const userId = session?.user.id ?? '';

  const [sessions, setSessions] = useState<ChatSession[] | null>(null);
  const [current, setCurrent] = useState<ChatSession | null>(null);
  const [saved, setSaved] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // Guards against two replies at once (the state update is too late to block a double submit).
  const busyRef = useRef(false);
  // The session the thread on screen belongs to. A reply that finishes for another session is
  // saved but not drawn here.
  const threadRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    listSessions(supabase)
      .then((list) => {
        if (alive) setSessions(list);
      })
      .catch((e) => {
        if (alive) setNotice(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!sessionId) {
      threadRef.current = null;
      setCurrent(null);
      setSaved([]);
      setPending(null);
      setMissing(false);
      return;
    }
    // A chat that was just created here is already on screen; do not reload it.
    if (current?.id === sessionId) return;
    if (!supabase) return;
    const db = supabase;
    let alive = true;
    setLoading(true);
    setMissing(false);
    setSaved([]);
    setPending(null);
    loadSession(db, sessionId)
      .then(async (found) => {
        if (!alive) return;
        if (!found) {
          setMissing(true);
          setCurrent(null);
          return;
        }
        const msgs = await loadMessages(db, sessionId);
        if (!alive) return;
        threadRef.current = sessionId;
        setCurrent(found);
        setSaved(msgs);
      })
      .catch((e) => {
        if (alive) setNotice(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [saved, pending]);

  // Streams a reply for `sid` from `history` and saves it. Used for a new message and for retry.
  async function runReply(sid: string, history: ChatMessage[]) {
    if (!supabase) return;
    const db = supabase;
    busyRef.current = true;
    setBusy(true);
    setPending({ status: 'streaming', content: '' });
    let partial = '';
    const owns = () => threadRef.current === sid;
    try {
      const { functionsUrl, anonKey } = functionsEndpoint();
      const result = await streamChat({
        functionsUrl,
        anonKey,
        getToken: freshToken,
        model: CHAT_MODEL,
        maxTokens: CHAT_MAX_TOKENS,
        messages: buildRequestMessages(history.map((m) => ({ role: m.role, content: m.content }))),
        onDelta: (chunk) => {
          partial += chunk;
          if (owns()) setPending({ status: 'streaming', content: partial });
        },
      });
      if (!result.text.trim()) throw new ChatError('empty_output');
      const reply = await appendMessage(db, sid, 'assistant', result.text);
      if (owns()) {
        setSaved((prev) => [...prev, reply]);
        setPending(null);
      }
      setSessions((prev) => (prev ? withUpdated(prev, sid, reply.createdAt) : prev));
    } catch (e) {
      if (owns()) setPending({ status: 'error', content: partial, message: describeChatError(e) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busyRef.current || !supabase) return;
    setDraft('');
    setNotice(null);
    setPending(null);
    busyRef.current = true;
    setBusy(true);
    try {
      let sid = current?.id ?? null;
      if (!sid) {
        const created = await createSession(supabase, userId, titleFrom(content));
        sid = created.id;
        threadRef.current = sid;
        setCurrent(created);
        setSessions((prev) => [created, ...(prev ?? [])]);
        navigate(`/chat/${sid}`);
      }
      const userMsg = await appendMessage(supabase, sid, 'user', content);
      if (threadRef.current === sid) setSaved((prev) => [...prev, userMsg]);
      await runReply(sid, [...(threadRef.current === sid ? saved : []), userMsg]);
    } catch (e) {
      busyRef.current = false;
      setBusy(false);
      setDraft(content);
      setNotice(errorText(e));
    }
  }

  async function removeSession(target: ChatSession) {
    if (!supabase || busyRef.current) return;
    if (!window.confirm(`Delete "${target.title}"? Its messages will be removed too.`)) return;
    try {
      await deleteSession(supabase, target.id);
      setSessions((prev) => (prev ? prev.filter((s) => s.id !== target.id) : prev));
      if (sessionId === target.id) navigate('/chat');
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  const thread = () => {
    if (missing) {
      return (
        <section className="app-chat-empty">
          <h2>This chat could not be found.</h2>
          <p className="app-muted">
            It may have been deleted. <Link to="/chat">Start a new chat</Link>.
          </p>
        </section>
      );
    }
    if (loading) return <p className="app-muted">Loading chat…</p>;
    if (saved.length === 0 && !pending) {
      return (
        <section className="app-chat-empty">
          <h2>What would you like to review?</h2>
          <p className="app-muted">
            General legal questions. No document is attached to this chat. For questions about a document, use Documents
            and Deep Analysis.
          </p>
        </section>
      );
    }
    return (
      <>
        {saved.map((m) => (
          <Bubble key={m.id} role={m.role} content={m.content} />
        ))}
        {pending?.status === 'streaming' && (
          <div className="app-chat-msg app-chat-msg--assistant" aria-busy="true">
            {pending.content ? <Markdown text={pending.content} /> : <span className="app-muted">Writing…</span>}
          </div>
        )}
        {pending?.status === 'error' && (
          <div className="app-chat-msg app-chat-msg--assistant app-chat-msg--error" role="alert">
            {pending.content && <Markdown text={pending.content} />}
            <p className="app-chat-error-text">{pending.message}</p>
            <button
              type="button"
              className="app-chat-retry"
              disabled={busy}
              onClick={() => threadRef.current && void runReply(threadRef.current, saved)}
            >
              Retry
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="app-chat-page">
      <PageHeader eyebrow="Module" title="Chat" description="Ask general legal questions. No document is attached." />
      <div className="app-chat-layout">
        <aside className="app-chat-list" aria-label="Chat sessions">
          <button type="button" className="app-chat-new" disabled={busy} onClick={() => navigate('/chat')}>
            New chat
          </button>
          {sessions === null ? (
            <p className="app-muted">Loading…</p>
          ) : sessions.length === 0 ? (
            <p className="app-muted app-chat-list-empty">Your chats will appear here.</p>
          ) : (
            <ul className="app-chat-sessions">
              {sessions.map((s) => (
                <li key={s.id} className={`app-chat-session${s.id === sessionId ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    className="app-chat-session-open"
                    disabled={busy}
                    onClick={() => navigate(`/chat/${s.id}`)}
                    title={s.title}
                  >
                    {s.title}
                  </button>
                  <button
                    type="button"
                    className="app-chat-session-delete"
                    disabled={busy}
                    aria-label={`Delete ${s.title}`}
                    onClick={() => void removeSession(s)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="app-chat-main">
          <div className="app-chat-thread" aria-live="polite">
            {thread()}
            <div ref={endRef} />
          </div>
          {notice && (
            <p className="app-chat-notice" role="alert">
              {notice}
            </p>
          )}
          <form className="app-composer app-chat-composer" onSubmit={onSubmit}>
            <textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKey}
              placeholder="Ask a legal question. Enter sends, Shift+Enter adds a line."
              aria-label="Chat message"
            />
            <button type="submit" className="app-primary-button" disabled={busy || !draft.trim()}>
              Send
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

function Bubble({ role, content }: { role: ChatMessage['role']; content: string }) {
  if (role === 'user') return <div className="app-chat-msg app-chat-msg--user">{content}</div>;
  return (
    <div className="app-chat-msg app-chat-msg--assistant">
      <Markdown text={content} />
    </div>
  );
}
