import { useEffect, useRef, useState } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import { openHarnessDb, type HarnessDBHandle } from '../runner/db';
import { createHandmadeRun, startRunWorker } from '../runner/client';
import { ACTIVE_STATUSES, type Task } from '../tasks/types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const MODEL = (import.meta.env.VITE_MODEL as string) || 'deepseek/deepseek-v4.1-flash';
const FALLBACK = (import.meta.env.VITE_FALLBACK_MODEL as string) || null;
const TEST_EMAIL = import.meta.env.VITE_TEST_EMAIL as string | undefined;
const TEST_PASSWORD = import.meta.env.VITE_TEST_PASSWORD as string | undefined;

const SAMPLE = [
  '1. Possession. The Supplier shall hand over the goods on or before 31 March 2027.',
  '2. Price. The total consideration is Rs. 1,25,00,000 payable in instalments as per Schedule B.',
  '3. Penalty. If the Supplier delays delivery beyond 6 months, it shall pay interest at 2% per month.',
].join('\n');

const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

export function TestPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [input, setInput] = useState(SAMPLE);
  const [maxTokens, setMaxTokens] = useState(1200);
  const [timeoutMs, setTimeoutMs] = useState(110000);
  const [runId, setRunId] = useState<string | null>(localStorage.getItem('lastRunId'));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const dbRef = useRef<HarnessDBHandle | null>(null);

  const addLog = (line: string) => setLog((l) => [...l.slice(-50), `${new Date().toLocaleTimeString()} ${line}`]);

  useEffect(() => {
    sb.auth.getSession().then(async ({ data }) => {
      if (!data.session && TEST_EMAIL && TEST_PASSWORD) {
        const r = await sb.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
        setSession(r.data.session);
        return;
      }
      setSession(data.session);
    });
    openHarnessDb().then((db) => (dbRef.current = db));
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const db = await openHarnessDb();
      if (cancelled) return;
      for (const s of await db.getAll('run_state')) {
        const tasks = await db.getAllFromIndex('tasks', 'byRun', s.runId);
        if (!tasks.some((t) => ACTIVE_STATUSES.includes(t.status))) continue;
        addLog(`resuming run ${s.runId}`);
        startRunWorker(
          {
            runId: s.runId,
            docHash: s.docHash,
            supabaseUrl: SUPABASE_URL,
            anonKey: ANON_KEY,
            accessToken: session.access_token,
            refreshToken: session.refresh_token,
            model: MODEL,
            fallbackModel: FALLBACK,
            timeoutMs: 110000,
          },
          (e) => addLog(JSON.stringify(e)),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (!runId) return;
    const t = setInterval(async () => {
      const db = dbRef.current;
      if (db) setTasks(await db.getAllFromIndex('tasks', 'byRun', runId));
    }, 1000);
    return () => clearInterval(t);
  }, [runId]);

  async function login() {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) addLog(`login failed: ${error.message}`);
  }

  async function start() {
    if (!session || !dbRef.current) return;
    const { runId: id, docHash } = await createHandmadeRun(dbRef.current, sb, {
      input,
      maxTokens,
      userId: session.user.id,
    });
    localStorage.setItem('lastRunId', id);
    setRunId(id);
    addLog(`run ${id} created`);
    startRunWorker(
      {
        runId: id,
        docHash,
        supabaseUrl: SUPABASE_URL,
        anonKey: ANON_KEY,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        model: MODEL,
        fallbackModel: FALLBACK,
        timeoutMs,
      },
      (e) => addLog(JSON.stringify(e)),
    );
  }

  if (!session) {
    return (
      <div style={{ padding: 16, fontFamily: 'sans-serif' }}>
        <h2>Login (test user)</h2>
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />{' '}
        <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />{' '}
        <button onClick={login}>Login</button>
        <pre>{log.join('\n')}</pre>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif' }}>
      <h2>Pipeline harness: hand-made task</h2>
      <textarea rows={8} cols={90} value={input} onChange={(e) => setInput(e.target.value)} />
      <div>
        max_tokens <input type="number" value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} />{' '}
        timeout ms <input type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} />{' '}
        <button onClick={start}>Start run</button>
      </div>
      <h3>Tasks {runId ? `(run ${runId})` : ''}</h3>
      <table border={1} cellPadding={4}>
        <thead>
          <tr>
            <th>id</th><th>status</th><th>attempt</th><th>failure</th><th>message</th><th>finish</th><th>provider</th>
            <th>tokens in/out</th><th>ms</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>{t.id}</td><td>{t.status}</td><td>{t.attemptNo}</td><td>{t.failureCode ?? ''}</td>
              <td style={{ maxWidth: 420, fontSize: 11 }}>{t.failureMessage ?? ''}</td>
              <td>{t.finishReason ?? ''}</td><td>{t.provider ?? ''}</td>
              <td>{t.promptTokens ?? ''} / {t.completionTokens ?? ''}</td><td>{t.durationMs ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre>{log.join('\n')}</pre>
    </div>
  );
}
