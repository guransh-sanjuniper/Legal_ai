import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../AuthProvider';
import { freshToken, functionsEndpoint } from '../../analysis/runtime';
import { CitationPanel } from '../../analysis/CitationPanel';
import '../../analysis/analysis.css';
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
  type MessageDocument,
} from '../../../chat/store';
import { buildRequestMessages, generalHistory, titleFrom } from '../../../chat/thread';
import { answerFromDocument, estimatesFor, loadDocumentContext, type DocumentContext } from '../../../chat/documentTurn';
import { citationLabel, MODE_LABEL } from '../../../chat/documentAnswer';
import { describePass } from '../../../chat/estimate';
import { openHarnessDb, type HarnessDBHandle } from '../../../runner/db';
import { isPrepared } from '../../library/preparationState';
import { RetrievalClient } from '../../../retrieval/client';
import type { Citation } from '../../../analysis/reportModel';

type Pending =
  | { status: 'streaming'; content: string }
  | { status: 'working'; label: string }
  | { status: 'error'; content: string; message: string; kind: 'general' | 'document' };

interface DocTurn {
  sid: string;
  question: string;
  ctx: DocumentContext;
  scanWhole: boolean;
}

interface ReadyDoc {
  id: string;
  name: string;
}

const GENERAL: MessageDocument = { documentId: null, documentName: null, mode: null, citations: null };

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

function withUpdated(list: ChatSession[], id: string, at: string): ChatSession[] {
  return list
    .map((s) => (s.id === id ? { ...s, updatedAt: at } : s))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// General chat and document chat share one thread. Each message keeps its own document context;
// a General request is built only from messages without one.
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
  // Replies that stopped at the output cap. Kept in memory for this view only; nothing is saved.
  const [truncated, setTruncated] = useState<Set<string>>(() => new Set());

  const [db, setDb] = useState<HarnessDBHandle | null>(null);
  const [readyDocs, setReadyDocs] = useState<ReadyDoc[] | null>(null);
  // '' means General: no document for the next message.
  const [docId, setDocId] = useState('');
  const [scanWhole, setScanWhole] = useState(false);
  const [docCtx, setDocCtx] = useState<DocumentContext | null>(null);
  const [openCitation, setOpenCitation] = useState<{ docId: string; citation: Citation } | null>(null);

  // Guards against two replies at once (the state update is too late to block a double submit).
  const busyRef = useRef(false);
  // The session the thread on screen belongs to. A reply that finishes for another session is
  // saved but not drawn here.
  const threadRef = useRef<string | null>(null);
  // The last document turn, so Retry can run it again.
  const lastDocTurn = useRef<DocTurn | null>(null);
  const retrieval = useRef<RetrievalClient | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const client = new RetrievalClient();
    retrieval.current = client;
    return () => client.dispose();
  }, []);

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

  // The documents a message can be about: only those prepared as Ready.
  useEffect(() => {
    let alive = true;
    openHarnessDb()
      .then(async (handle) => {
        const all = await handle.getAll('documents');
        const ready: ReadyDoc[] = [];
        for (const d of all) {
          if (await isPrepared(handle, d)) ready.push({ id: d.id, name: d.name });
        }
        if (alive) {
          setDb(handle);
          setReadyDocs(ready);
        }
      })
      .catch((e) => {
        if (alive) setNotice(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!docId || !db) {
      setDocCtx(null);
      return;
    }
    let alive = true;
    setDocCtx(null);
    loadDocumentContext(db, supabase, docId)
      .then((ctx) => {
        if (alive) setDocCtx(ctx);
      })
      .catch((e) => {
        if (alive) {
          setNotice(errorText(e));
          setDocId('');
          setScanWhole(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [docId, db]);

  const estimates = useMemo(() => (docCtx ? estimatesFor(docCtx) : null), [docCtx]);

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
    const client = supabase;
    let alive = true;
    setLoading(true);
    setMissing(false);
    setSaved([]);
    setPending(null);
    loadSession(client, sessionId)
      .then(async (found) => {
        if (!alive) return;
        if (!found) {
          setMissing(true);
          setCurrent(null);
          return;
        }
        const msgs = await loadMessages(client, sessionId);
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

  // Streams a General reply for `sid` from `history` and saves it. Used for a new message and for retry.
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
        messages: buildRequestMessages(generalHistory(history).map((m) => ({ role: m.role, content: m.content }))),
        onDelta: (chunk) => {
          partial += chunk;
          if (owns()) setPending({ status: 'streaming', content: partial });
        },
      });
      if (!result.text.trim()) throw new ChatError('empty_output');
      const reply = await appendMessage(db, sid, 'assistant', result.text);
      if (owns()) {
        if (result.finishReason === 'length') setTruncated((prev) => new Set(prev).add(reply.id));
        setSaved((prev) => [...prev, reply]);
        setPending(null);
      }
      setSessions((prev) => (prev ? withUpdated(prev, sid, reply.createdAt) : prev));
    } catch (e) {
      if (owns()) setPending({ status: 'error', content: partial, message: describeChatError(e), kind: 'general' });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // Answers one document question for `sid` and saves the reply with its document context.
  async function runDocumentReply(turn: DocTurn) {
    if (!supabase || !db || !retrieval.current) return;
    const sid = turn.sid;
    lastDocTurn.current = turn;
    const client = retrieval.current;
    busyRef.current = true;
    setBusy(true);
    setPending({ status: 'working', label: 'Searching the document…' });
    const owns = () => threadRef.current === sid;
    try {
      const token = await freshToken();
      if (!token) throw new Error('Sign in again to ask about a document.');
      const { functionsUrl, anonKey } = functionsEndpoint();
      const out = await answerFromDocument(turn.question, turn.ctx, turn.scanWhole, {
        db,
        supabase,
        accessToken: token,
        refreshAccessToken: freshToken,
        userId: userId || null,
        functionsUrl,
        anonKey,
        search: (id, q, k) => client.search(id, q, k),
        onStatus: (label) => {
          if (owns()) setPending({ status: 'working', label });
        },
      });
      const reply = await appendMessage(supabase, sid, 'assistant', out.content, {
        documentId: turn.ctx.doc.id,
        documentName: turn.ctx.doc.name,
        mode: out.mode,
        citations: out.citations,
      });
      if (owns()) {
        setSaved((prev) => [...prev, reply]);
        setPending(null);
      }
      setSessions((prev) => (prev ? withUpdated(prev, sid, reply.createdAt) : prev));
    } catch (e) {
      if (owns()) setPending({ status: 'error', content: '', message: errorText(e), kind: 'document' });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busyRef.current || !supabase) return;
    const ctx = docId ? docCtx : null;
    if (docId && ctx?.doc.id !== docId) return;
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
      const meta: MessageDocument = ctx
        ? { documentId: ctx.doc.id, documentName: ctx.doc.name, mode: null, citations: null }
        : GENERAL;
      const userMsg = await appendMessage(supabase, sid, 'user', content, meta);
      if (threadRef.current === sid) setSaved((prev) => [...prev, userMsg]);
      if (ctx) {
        await runDocumentReply({ sid, question: content, ctx, scanWhole });
      } else {
        await runReply(sid, [...(threadRef.current === sid ? saved : []), userMsg]);
      }
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

  function chooseDocument(id: string) {
    setDocId(id);
    if (!id) setScanWhole(false);
  }

  function retryPending() {
    if (pending?.status !== 'error') return;
    if (pending.kind === 'document') {
      if (lastDocTurn.current) void runDocumentReply(lastDocTurn.current);
      return;
    }
    if (threadRef.current) void runReply(threadRef.current, saved);
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

  // The document the composer targets is loaded before a message can be sent about it.
  const docReady = !docId || docCtx?.doc.id === docId;

  const hint = (() => {
    if (!docId) return null;
    if (!docReady || !estimates) return 'Loading document…';
    if (scanWhole) return `${describePass('Whole-document scan', estimates.whole)} Starts when you press Send.`;
    const label = docCtx?.report
      ? 'If the saved report does not answer it, retrieval (up to 12 sections)'
      : 'Retrieval (up to 12 sections; no saved report)';
    return describePass(label, estimates.retrieval);
  })();

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
            General legal questions. To ask about a prepared document, choose it below the thread before you send.
          </p>
        </section>
      );
    }
    return (
      <>
        {saved.map((m) => (
          <Bubble
            key={m.id}
            message={m}
            note={truncated.has(m.id) ? 'Response may be incomplete.' : undefined}
            onOpenCitation={(d, c) => setOpenCitation({ docId: d, citation: c })}
          />
        ))}
        {pending?.status === 'streaming' && (
          <div className="app-chat-msg app-chat-msg--assistant" aria-busy="true">
            {pending.content ? <Markdown text={pending.content} /> : <span className="app-muted">Writing…</span>}
          </div>
        )}
        {pending?.status === 'working' && (
          <div className="app-chat-msg app-chat-msg--assistant" aria-busy="true">
            <span className="app-muted">{pending.label}</span>
          </div>
        )}
        {pending?.status === 'error' && (
          <div className="app-chat-msg app-chat-msg--assistant app-chat-msg--error" role="alert">
            {pending.content && <Markdown text={pending.content} />}
            <p className="app-chat-error-text">{pending.message}</p>
            <button type="button" className="app-chat-retry" disabled={busy} onClick={retryPending}>
              Retry
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="app-chat-page">
      <PageHeader
        eyebrow="Module"
        title="Chat"
        description="Ask general legal questions, or choose a prepared document to ask about it."
      />
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
          <div className="app-chat-docbar">
            <label className="app-chat-doc-pick">
              <span>Ask about</span>
              <select
                value={docId}
                disabled={busy || readyDocs === null}
                onChange={(e) => chooseDocument(e.target.value)}
              >
                <option value="">General (no document)</option>
                {(readyDocs ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="app-chat-scan">
              <input
                type="checkbox"
                checked={scanWhole}
                disabled={busy || !docId}
                onChange={(e) => setScanWhole(e.target.checked)}
              />
              Scan whole document
            </label>
          </div>
          {hint && <p className="app-chat-estimate">{hint}</p>}
          <form className="app-composer app-chat-composer" onSubmit={onSubmit}>
            <textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKey}
              placeholder={docId ? 'Ask about this document. Enter sends, Shift+Enter adds a line.' : 'Ask a legal question. Enter sends, Shift+Enter adds a line.'}
              aria-label="Chat message"
            />
            <button
              type="submit"
              className="app-primary-button"
              disabled={busy || !draft.trim() || !docReady}
            >
              {scanWhole && docId ? 'Scan' : 'Send'}
            </button>
          </form>
        </section>
      </div>
      {openCitation && (
        <CitationPanel
          docId={openCitation.docId}
          citation={openCitation.citation}
          onClose={() => setOpenCitation(null)}
        />
      )}
    </div>
  );
}

function Bubble({
  message,
  note,
  onOpenCitation,
}: {
  message: ChatMessage;
  note?: string;
  onOpenCitation: (docId: string, c: Citation) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="app-chat-msg app-chat-msg--user">
        {message.content}
        {message.documentName && <div className="app-chat-doc-tag">About {message.documentName}</div>}
      </div>
    );
  }
  const citations = message.citations ?? [];
  return (
    <div className="app-chat-msg app-chat-msg--assistant">
      {message.mode && message.documentName && (
        <p className="app-chat-doc-tag">
          {message.documentName} · {MODE_LABEL[message.mode]}
        </p>
      )}
      <Markdown text={message.content} />
      {note && <p className="app-chat-note">{note}</p>}
      {citations.length > 0 && message.documentId && (
        <div className="app-chat-sources">
          <span className="app-muted">Sources</span>
          {citations.map((c, i) => (
            <button
              key={`${c.page}|${c.clause}|${i}`}
              type="button"
              className="app-chat-source"
              onClick={() => onOpenCitation(message.documentId!, c)}
            >
              {citationLabel(c)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
