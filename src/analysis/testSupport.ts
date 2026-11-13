// Shared helpers for the analysis tests that run against the hosted Supabase project.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, DocumentRecord } from '../runner/db';
import type { CallRequest } from '../tasks/types';
import { STATUTORY_POINT } from './prompts';

const URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const EMAIL = import.meta.env.VITE_TEST_EMAIL as string;
const PASSWORD = import.meta.env.VITE_TEST_PASSWORD as string;

export async function signIn(): Promise<{ sb: SupabaseClient; token: string; userId: string; url: string; anon: string }> {
  const sb = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error || !auth.session) throw error ?? new Error('no session');
  return { sb, token: auth.session.access_token, userId: auth.session.user.id, url: URL, anon: ANON };
}

// Four synthetic pages, one numbered clause each. Quotes in the scripted model come from these pages.
export async function seedDocument(db: HarnessDBHandle, docId: string, prepFingerprint: string): Promise<void> {
  const pages = Array.from({ length: 4 }, (_, i) => ({
    pageNo: i + 1,
    text: `${i + 1}. Obligation ${i + 1}\nThe Developer shall perform obligation ${i + 1}. ${'Additional text. '.repeat(220)}`,
  }));
  const now = Date.now();
  const doc: DocumentRecord = {
    id: docId, name: `${docId}.pdf`, hash: `${docId}-hash`, size: 0, createdAt: now,
    status: 'ready', ocrLangs: 'eng', pageCount: pages.length, prepFingerprint, chunkCount: 0, docType: null,
  };
  await db.put('documents', doc);
  for (const p of pages) {
    await db.put('pages', {
      docId, pageNo: p.pageNo, text: p.text, status: 'native', source: 'native', reason: null, dpi: null,
      nativeChars: p.text.length, imageCount: 0, updatedAt: now,
    }, [docId, p.pageNo]);
  }
  await db.put('definitions', {
    docId, prepFingerprint,
    sheet: { parties: [], defined_terms: [], key_dates: [], sources: [] }, updatedAt: now,
  });
}

// Answers each pass by its prompt. Quotes are copied from the synthetic pages above.
export function scriptedModel(req: CallRequest): string {
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
  if (req.prompt.includes('review proposed risks')) {
    const batch = JSON.parse(req.input) as { id: string }[];
    return JSON.stringify(batch.map((r) => ({ id: r.id, verdict: 'keep', reason: 'genuine risk' })));
  }
  if (req.prompt.includes('final answer to a user request')) {
    const answers = JSON.parse(req.input.slice(req.input.indexOf('Verified answers:\n') + 18));
    const first = answers[0];
    return JSON.stringify([{ text: 'Clause two states the obligation.', cites: first ? [first.id] : [] }]);
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
