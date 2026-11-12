import 'fake-indexeddb/auto';
import { it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { openHarnessDb, type DocumentRecord } from '../runner/db';
import { runAnalysis, restoreReportFromSupabase } from './runAnalysis';
import type { CallRequest, CallResult } from '../tasks/types';
import { STATUTORY_POINT } from './prompts';

const URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const EMAIL = import.meta.env.VITE_TEST_EMAIL as string;
const PASSWORD = import.meta.env.VITE_TEST_PASSWORD as string;

// Scripted model: answers each pass by its prompt. Quotes are copied from the synthetic pages below.
function scripted(req: CallRequest): string {
  const itemsFromInput = () => JSON.parse(req.input.slice(req.input.indexOf('Items:\n') + 7));
  if (req.prompt.includes('USER REQUEST:')) {
    return JSON.stringify([{ text: 'Clause two states the obligation.', page: 2, quote: 'The Developer shall perform obligation 2.', clause_no: '2' }]);
  }
  if (req.prompt.includes('Return exactly ONE item')) {
    const nums = /CLAUSE NUMBERS IN THIS EXCERPT: ([^\n]+)/.exec(req.input)![1].split(', ');
    return JSON.stringify(
      nums.map((n) => ({
        clause_no: n,
        type: 'obligation',
        summary: 'One sentence.',
        obligations: [],
        dates: [],
        payments: [],
        risks: [
          {
            text: 'The obligation is one-sided.',
            priority: 'high',
            basis: 'other',
            suggestion: 'Negotiate mutual terms.',
            laws: ['Indian Contract Act 1872', 'indian contract act 1872'],
            page: Number(n),
            quote: `The Developer shall perform obligation ${n}.`,
          },
        ],
        missing: ['No notice period'],
        prose: { detailed_summary: 'Detailed text.', rights: '' },
      })),
    );
  }
  if (req.prompt.includes('numbered overview')) {
    const cite = itemsFromInput().sections[0]?.cites?.[0];
    return JSON.stringify([
      { point: 4, text: 'The developer performs its obligations.', cites: cite ? [cite] : [] },
      { point: STATUTORY_POINT, text: 'Model tried to write point 11.', cites: cite ? [cite] : [] },
    ]);
  }
  if (req.prompt.includes('check a legal contract for missing protections')) {
    return JSON.stringify([
      { topic: 'insurance cover', text: 'No insurance cover is stated.', priority: 'high', basis: 'other', suggestion: 'Ask for insurance terms.', laws: [], cites: [] },
    ]);
  }
  if (req.prompt.includes('You summarise verified clause analysis')) {
    const first = itemsFromInput()[0];
    return JSON.stringify([{ text: 'Section sentence.', cites: [first.id] }]);
  }
  return '[]';
}

it('runs the general analysis, custom pass, missing pass and overview points; restores the report', async () => {
  const db = await openHarnessDb();
  const sb = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error || !auth.session) throw error ?? new Error('no session');

  const docId = 'stage-a-test';
  const pages = Array.from({ length: 4 }, (_, i) => ({
    pageNo: i + 1,
    text: `${i + 1}. Obligation ${i + 1}\nThe Developer shall perform obligation ${i + 1}. ${'Additional text. '.repeat(220)}`,
  }));
  const now = Date.now();
  const doc: DocumentRecord = {
    id: docId, name: 'stage-a-test.pdf', hash: 'stage-a-test-hash', size: 0, createdAt: now,
    status: 'ready', ocrLangs: 'eng', pageCount: pages.length, prepFingerprint: 'stage-a-v1', chunkCount: 0, docType: null,
  };
  await db.put('documents', doc);
  for (const p of pages) {
    await db.put('pages', {
      docId, pageNo: p.pageNo, text: p.text, status: 'native', source: 'native', reason: null, dpi: null,
      nativeChars: p.text.length, imageCount: 0, updatedAt: now,
    }, [docId, p.pageNo]);
  }
  await db.put('definitions', {
    docId, prepFingerprint: 'stage-a-v1',
    sheet: { parties: [], defined_terms: [], key_dates: [], sources: [] }, updatedAt: now,
  });

  let lawCalls = 0;
  const opts = {
    db, supabase: sb, accessToken: auth.session.access_token, userId: auth.session.user.id,
    functionsUrl: `${URL}/functions/v1`, anonKey: ANON, docId, model: 'fake', fallbackModel: null,
    reasoning: { effort: 'minimal' as const }, maxTokens: 2000, autoReduceConcurrency: false,
    lawSearch: async () => { lawCalls++; return []; },
    docSearch: async () => [],
    callModel: async (req: CallRequest): Promise<CallResult> => ({
      text: scripted(req), finishReason: 'stop', provider: 'fake', promptTokens: 10, completionTokens: 10, durationMs: 1,
    }),
  };

  const withPrompt = await runAnalysis({
    ...opts,
    request: { detailLevel: 'brief', focus: 'notice and exit', customPrompt: 'Which clause states the obligation?' },
  });

  expect(lawCalls).toBe(0);
  expect(withPrompt.request).toMatchObject({ detailLevel: 'brief', focus: 'notice and exit' });

  const risks = withPrompt.clauses.flatMap((c) => c.risks);
  expect(risks.length).toBeGreaterThan(0);
  for (const r of risks) {
    expect(r.severity).toBe('medium');
    expect(r.suggestion).toBe('Negotiate mutual terms.');
    expect(r.laws).toEqual(['Indian Contract Act 1872']);
    expect(r.lawPassages).toBeUndefined();
  }
  expect(withPrompt.clauses[0].missing).toEqual(['No notice period']);
  expect(withPrompt.clauses[0].prose?.detailed_summary).toBe('Detailed text.');

  expect(withPrompt.missingProtections).toHaveLength(1);
  expect(withPrompt.missingProtections![0]).toMatchObject({ topic: 'insurance cover', severity: 'medium', applicability: 'unverified' });

  expect(withPrompt.overviewPoints).toHaveLength(14);
  const statutory = withPrompt.overviewPoints![STATUTORY_POINT - 1].sentences.map((s) => s.text).join(' ');
  expect(statutory).toMatch(/Indian Contract Act 1872 \(model knowledge, applicability unverified\)/);
  expect(statutory).not.toMatch(/Model tried/);
  expect(withPrompt.overviewPoints![3].sentences.length).toBeGreaterThan(0);
  expect(withPrompt.notices).toContain('Law references are model knowledge; their applicability is unverified.');

  expect(withPrompt.promptResult).toBeDefined();
  expect(withPrompt.promptResult!.failedChunks).toEqual([]);
  expect(withPrompt.promptResult!.answers.length).toBeGreaterThan(0);
  for (const a of withPrompt.promptResult!.answers) expect(a).toMatchObject({ verified: true, page: 2 });

  const restored = await restoreReportFromSupabase(sb, docId);
  expect(restored?.runId).toBe(withPrompt.runId);

  const general = await runAnalysis({ ...opts, request: { customPrompt: '   ' } });
  expect(general.promptResult).toBeUndefined();
  expect(general.clauses.map((c) => c.clauseNo)).toEqual(withPrompt.clauses.map((c) => c.clauseNo));
  expect(general.overviewPoints!.map((p) => p.sentences.length)).toEqual(withPrompt.overviewPoints!.map((p) => p.sentences.length));
}, 180_000);
