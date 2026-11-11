import { useEffect, useRef, useState } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import { openHarnessDb, type HarnessDBHandle, type DocumentRecord } from '../runner/db';
import { RetrievalClient, type SearchResult, type LawResult } from '../retrieval/client';
import { buildDefinitionsSheet, getDefinitions, definitionsContext } from '../retrieval/definitions';
import type { DefinitionsSheet } from '../retrieval/definitionsMerge';
import { EMBED_MODEL_VERSION, LAW_STANDIN_VERSION } from '../retrieval/config';
import { LAW_NOTICE } from '../retrieval/lawSearch';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_ANON_KEY ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string);
const LLM_MODEL =
  (import.meta.env.VITE_SEARCH_MODEL as string) || (import.meta.env.VITE_MODEL as string) || 'deepseek/deepseek-v4.1-flash';
const FALLBACK = (import.meta.env.VITE_FALLBACK_MODEL as string) || null;
const TEST_EMAIL = import.meta.env.VITE_TEST_EMAIL as string | undefined;
const TEST_PASSWORD = import.meta.env.VITE_TEST_PASSWORD as string | undefined;

const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

export function SearchPage() {
  const [db, setDb] = useState<HarnessDBHandle | null>(null);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [docId, setDocId] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [query, setQuery] = useState('payment of maintenance charges');
  const [scope, setScope] = useState<'document' | 'law'>('document');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [lawResults, setLawResults] = useState<LawResult[]>([]);
  const [status, setStatus] = useState<string>('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [embedMs, setEmbedMs] = useState<number | null>(null);
  const [sheet, setSheet] = useState<DefinitionsSheet | null>(null);
  const [busy, setBusy] = useState(false);
  const clientRef = useRef<RetrievalClient | null>(null);
  const embedStart = useRef<number | null>(null);

  useEffect(() => {
    openHarnessDb().then(async (handle) => {
      setDb(handle);
      setDocs((await handle.getAll('documents')).filter((d) => d.status === 'ready').sort((a, b) => b.createdAt - a.createdAt));
    });
    sb.auth.getSession().then(async ({ data }) => {
      if (!data.session && TEST_EMAIL && TEST_PASSWORD) {
        const r = await sb.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
        setSession(r.data.session);
        return;
      }
      setSession(data.session);
    });
    clientRef.current = new RetrievalClient((e) => {
      if (e.type === 'model-loading') setStatus(`loading embedding model (${EMBED_MODEL_VERSION})…`);
      else if (e.type === 'embed-progress') setProgress({ done: e.done as number, total: e.total as number });
      else if (e.type === 'embed-done') {
        setStatus(`embedded ${e.windows} windows`);
        if (embedStart.current) setEmbedMs(Date.now() - embedStart.current);
        setProgress(null);
      } else if (e.type === 'error') setStatus(`error: ${e.message}`);
    });
    return () => clientRef.current?.dispose();
  }, []);

  useEffect(() => {
    const client = clientRef.current;
    if (!db || !docId || !client) return;
    getDefinitions(db, docId).then(setSheet);
    client.status(docId).then((r) => {
      const s = r.state as { windowsTotal?: number; modelVersion?: string } | null;
      setStatus(
        s
          ? `${s.windowsTotal ?? 0} windows embedded, model ${s.modelVersion ?? '?'} (current ${EMBED_MODEL_VERSION})`
          : 'not embedded yet',
      );
    });
  }, [docId, db]);

  async function runEmbed() {
    if (!clientRef.current || !docId) return;
    setBusy(true);
    embedStart.current = Date.now();
    setEmbedMs(null);
    try {
      await clientRef.current.embed(docId);
    } catch (e) {
      setStatus(`error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!clientRef.current) return;
    setBusy(true);
    setStatus('searching…');
    try {
      if (scope === 'document') {
        if (!docId) throw new Error('select a document first');
        const r = await clientRef.current.search(docId, query, 5);
        setResults(r.results);
        setStatus(`${r.results.length} result(s)`);
      } else {
        const r = await clientRef.current.lawSearch(query, 5);
        setLawResults(r.results);
        setStatus(`${r.results.length} law passage(s) — ${LAW_STANDIN_VERSION}`);
      }
    } catch (e) {
      setStatus(`error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runDefinitions() {
    if (!db || !docId || !session) {
      setStatus('login and select a ready document first');
      return;
    }
    setBusy(true);
    setStatus('building definitions sheet (one task per definition chunk)…');
    try {
      const out = await buildDefinitionsSheet({
        db,
        supabase: sb,
        accessToken: session.access_token,
        userId: session.user.id,
        docId,
        model: LLM_MODEL,
        fallbackModel: FALLBACK,
        functionsUrl: `${SUPABASE_URL}/functions/v1`,
        anonKey: ANON_KEY,
        reasoning: { effort: 'minimal' },
        onProgress: (m) => setStatus(`definitions: ${m}`),
      });
      setSheet(out.sheet);
      setStatus(`definitions sheet written (${out.tasks} tasks, ${out.failed} failed)`);
    } catch (e) {
      setStatus(`error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif', maxWidth: 1100 }}>
      <h2>Search</h2>
      <div>
        Document:{' '}
        <select value={docId ?? ''} onChange={(e) => setDocId(e.target.value || null)} style={{ minWidth: 320 }}>
          <option value="">-- select a ready document --</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.pageCount}p, {d.chunkCount} chunks)
            </option>
          ))}
        </select>{' '}
        <button disabled={busy || !docId} onClick={runEmbed}>
          Embed / resume
        </button>{' '}
        <button disabled={busy || !docId || !session} onClick={runDefinitions}>
          Build definitions sheet
        </button>
      </div>

      <div style={{ marginTop: 8 }}>Status: {status}</div>
      {progress && (
        <div>
          Embedding {progress.done}/{progress.total}
          <progress value={progress.done} max={progress.total} style={{ marginLeft: 8 }} />
        </div>
      )}
      {embedMs !== null && <div>Last embedding run: {(embedMs / 1000).toFixed(1)}s</div>}

      <hr />
      <div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 520 }} />{' '}
        <select value={scope} onChange={(e) => setScope(e.target.value as 'document' | 'law')}>
          <option value="document">Document</option>
          <option value="law">Law stand-in</option>
        </select>{' '}
        <button disabled={busy} onClick={runSearch}>
          Search
        </button>
      </div>
      {scope === 'law' && <div style={{ color: '#a00', fontSize: 12, marginTop: 6 }}>{LAW_NOTICE}</div>}

      {scope === 'document' && results.length > 0 && (
        <table border={1} cellPadding={4} style={{ marginTop: 8 }}>
          <thead>
            <tr><th>page</th><th>clauses</th><th>fused</th><th>vector</th><th>keyword</th><th>window</th></tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.chunkId}>
                <td>{r.pageStart}-{r.pageEnd}</td>
                <td>{r.clauses.join(', ') || r.clauseFrom || '-'}</td>
                <td>{r.fused.toFixed(4)}</td>
                <td>{r.vectorScore.toFixed(3)}</td>
                <td>{r.keywordScore.toFixed(2)}</td>
                <td style={{ maxWidth: 520 }}>{r.windowText.slice(0, 260)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {scope === 'law' && lawResults.length > 0 && (
        <table border={1} cellPadding={4} style={{ marginTop: 8 }}>
          <thead>
            <tr><th>id</th><th>title</th><th>fused</th><th>vector</th><th>text</th></tr>
          </thead>
          <tbody>
            {lawResults.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.title}</td>
                <td>{r.fused.toFixed(4)}</td>
                <td>{r.vectorScore.toFixed(3)}</td>
                <td style={{ maxWidth: 520 }}>{r.text.slice(0, 220)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {sheet && (
        <>
          <h3>Definitions sheet</h3>
          <div>
            Parties:{' '}
            {sheet.parties.map((p) => `${p.name} [${p.role === 'party_to_agreement' ? 'agreement' : 'mentioned'}]`).join(' · ') || '(none)'}
          </div>
          <table border={1} cellPadding={3} style={{ marginTop: 6 }}>
            <thead>
              <tr><th>term</th><th>definition</th><th>clause</th><th>page</th></tr>
            </thead>
            <tbody>
              {sheet.defined_terms.map((t) => (
                <tr key={t.term}>
                  <td>{t.term}</td>
                  <td style={{ maxWidth: 460 }}>{t.definition}</td>
                  <td>{t.clause ?? ''}</td>
                  <td>{t.page ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 6 }}>Key dates: {sheet.key_dates.map((d) => `${d.date} (${d.description})`).join('; ') || '(none)'}</div>
        </>
      )}
      <div style={{ marginTop: 8, fontSize: 11, color: '#666' }}>
        Model {EMBED_MODEL_VERSION}. Embeddings are stored locally; only search text and task input leave the device through the proxy.
      </div>
      <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
        Use <code>VITE_SEARCH_MODEL</code> for the definitions model (defaults to the embedding model id, which is not an LLM).
      </div>
      <ContextPreview docId={docId} db={db} />
    </div>
  );
}

function ContextPreview({ docId, db }: { docId: string | null; db: HarnessDBHandle | null }) {
  const [text, setSheetText] = useState('');
  useEffect(() => {
    if (!db || !docId) {
      setSheetText('');
      return;
    }
    getDefinitions(db, docId).then((s) => setSheetText(definitionsContext(s)));
  }, [docId, db]);
  if (!text) return null;
  return (
    <details style={{ marginTop: 8 }}>
      <summary>Definitions context (attachable)</summary>
      <pre>{text}</pre>
    </details>
  );
}
