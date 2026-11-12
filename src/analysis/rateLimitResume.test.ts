import 'fake-indexeddb/auto';
import { it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { openHarnessDb, type DocumentRecord } from '../runner/db';
import { runAnalysis, RateLimitedPause } from './runAnalysis';
import { CallError, type CallRequest, type CallResult } from '../tasks/types';

const URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const EMAIL = import.meta.env.VITE_TEST_EMAIL as string;
const PASSWORD = import.meta.env.VITE_TEST_PASSWORD as string;

it('pauses after three 429s and resumes the same run without new results', async () => {
  const db = await openHarnessDb();
  const sb = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error || !auth.session) throw error ?? new Error('no session');

  const docId = 'resume-test';
  const pages = Array.from({ length: 6 }, (_, i) => ({
    pageNo: i + 1,
    text: `${i + 1}. Obligation ${i + 1}\nThe Developer shall perform obligation ${i + 1}. ${'Additional text. '.repeat(220)}`,
  }));
  const now = Date.now();
  const doc: DocumentRecord = {
    id: docId, name: 'resume-test.pdf', hash: 'resume-test-hash', size: 0, createdAt: now,
    status: 'ready', ocrLangs: 'eng', pageCount: pages.length, prepFingerprint: 'resume-test-v1', chunkCount: 0, docType: null,
  };
  await db.put('documents', doc);
  for (const p of pages) {
    await db.put('pages', {
      docId, pageNo: p.pageNo, text: p.text, status: 'native', source: 'native', reason: null, dpi: null,
      nativeChars: p.text.length, imageCount: 0, updatedAt: now,
    }, [docId, p.pageNo]);
  }
  await db.put('definitions', {
    docId, prepFingerprint: 'resume-test-v1',
    sheet: { parties: [], defined_terms: [], key_dates: [], sources: [] }, updatedAt: now,
  });

  let calls = 0;
  const fakeCall = async (_req: CallRequest): Promise<CallResult> => {
    calls++;
    if (calls <= 3) throw new CallError('http_429', 'rate limited', 5);
    return { text: '[]', finishReason: 'stop', provider: 'fake', promptTokens: 0, completionTokens: 0, durationMs: 1 };
  };
  const opts = {
    db, supabase: sb, accessToken: auth.session.access_token, userId: auth.session.user.id,
    functionsUrl: `${URL}/functions/v1`, anonKey: ANON, docId, model: 'fake', fallbackModel: null,
    reasoning: { effort: 'minimal' as const }, maxTokens: 800, maxConsecutive429: 3, autoReduceConcurrency: false,
    lawSearch: async () => [], docSearch: async () => { throw new Error('retrieval disabled'); },
    callModel: fakeCall,
  };

  let paused: RateLimitedPause | null = null;
  try {
    await runAnalysis(opts);
  } catch (e) {
    if (e instanceof RateLimitedPause) paused = e;
    else throw e;
  }
  expect(paused).not.toBeNull();
  expect(calls).toBeGreaterThanOrEqual(3);

  const report = await runAnalysis({ ...opts, resumeRunId: paused!.runId });
  const tasks = await db.getAllFromIndex('tasks', 'byRun', report.runId);
  expect(tasks.filter((t) => t.status === 'failed')).toHaveLength(0);
  expect(report.metrics.rateLimitEvents).toBe(3);
  expect(report.metrics.rateLimitWaitMs).toBeGreaterThanOrEqual(3000);
  expect(tasks.every((t) => t.status === 'done' || t.status === 'split')).toBe(true);
});
