import type { SupabaseClient } from '@supabase/supabase-js';
import type { HarnessDBHandle, ChunkRecord } from '../runner/db';
import { makeTask } from '../tasks/make';
import { runTask } from '../runner/runTask';
import { makeCallModel } from '../runner/callModel';
import { ACTIVE_STATUSES, type ReasoningEffort, type ResultRow, type RunConfig } from '../tasks/types';
import { isValidDefinitionItem, mergeDefinitions, type DefinitionItem, type DefinitionsSheet } from './definitionsMerge';

export const DEFINITIONS_PROMPT_VERSION = 'definitions-v1';

export const DEFINITIONS_PROMPT = [
  'You extract parties, defined terms and key dates from one excerpt of a legal contract.',
  'Return ONLY a JSON array, with no prose. Each item is one of:',
  '{"kind":"party","name":"...","clause":"...","page":number}',
  '{"kind":"term","term":"...","definition":"...","clause":"...","page":number}',
  '{"kind":"date","date":"...","description":"...","clause":"...","page":number}',
  'Copy names, terms and dates exactly as written. Use null when a clause or page is unknown.',
  'Return at most 30 items. Keep each definition under 200 characters.',
  'Return an empty array if the excerpt has no parties, definitions or dates.',
].join('\n');

const DEFINITION_CUE =
  /(shall mean|means|hereinafter|referred to as|definitions?|party|parties|society|developer|purchaser|allottee|lessor|licensor|LLP|private limited)/i;

export function selectDefinitionChunks(chunks: ChunkRecord[], max = 8): ChunkRecord[] {
  return [...chunks]
    .sort((a, b) => a.index - b.index)
    .filter((c) => DEFINITION_CUE.test(c.text))
    .slice(0, max);
}

export interface DefinitionsOptions {
  db: HarnessDBHandle;
  supabase: SupabaseClient;
  accessToken: string;
  userId?: string | null;
  docId: string;
  model: string;
  fallbackModel: string | null;
  functionsUrl: string;
  anonKey: string;
  reasoning?: { effort: ReasoningEffort } | null;
  onProgress?: (msg: string) => void;
}

export interface DefinitionsOutcome {
  sheet: DefinitionsSheet;
  runId: string;
  tasks: number;
  failed: number;
}

export async function buildDefinitionsSheet(opts: DefinitionsOptions): Promise<DefinitionsOutcome> {
  const { db, supabase, docId } = opts;
  const doc = await db.get('documents', docId);
  if (!doc?.prepFingerprint) throw new Error('document is not ready');
  const chunks = (await db.getAll('chunks', IDBKeyRange.bound(`${docId}:`, `${docId}:\uffff`))).sort((a, b) => a.index - b.index);
  const selected = selectDefinitionChunks(chunks);
  if (selected.length === 0) throw new Error('no definition or party text found in this document');

  const runId = crypto.randomUUID();
  const { error: runErr } = await supabase.from('runs').insert({
    id: runId,
    user_id: opts.userId ?? null,
    doc_hash: doc.hash,
    prep_fingerprint: doc.prepFingerprint,
    status: 'running',
  });
  if (runErr) throw runErr;

  const now = Date.now();
  const tasks = await Promise.all(
    selected.map(async (chunk, i) =>
      makeTask(
        {
          id: `${runId}:d${i}`,
          runId,
          parentId: null,
          depth: 0,
          docHash: doc.hash,
          prepFingerprint: doc.prepFingerprint!,
          promptVersion: DEFINITIONS_PROMPT_VERSION,
          prompt: DEFINITIONS_PROMPT,
          input: `Excerpt (pages ${chunk.pageStart}-${chunk.pageEnd}, clauses ${chunk.clauseFrom ?? '?'}-${chunk.clauseTo ?? '?'}):\n${chunk.text}`,
          maxTokens: 2000,
        },
        now,
      ),
    ),
  );
  for (const t of tasks) await db.put('tasks', t);

  const items: DefinitionItem[] = [];
  const cfg: RunConfig = {
    callModel: makeCallModel({ functionsUrl: opts.functionsUrl, anonKey: opts.anonKey, accessToken: opts.accessToken }),
    saveResult: async (row: ResultRow) => {
      const { error } = await supabase.rpc('save_task_result', { p_row: row });
      if (error) throw error;
      const payload = row.payload as { items?: unknown[] } | null;
      if (payload?.items) {
        for (const item of payload.items) if (isValidDefinitionItem(item)) items.push(item);
      }
    },
    validateItem: isValidDefinitionItem,
    model: opts.model,
    fallbackModel: opts.fallbackModel,
    timeoutMs: 110_000,
    reasoning: opts.reasoning ?? null,
    maxRetries: 3,
    minPieceChars: 1500,
    maxSplitDepth: 2,
    backoffMs: (n) => Math.min(30_000, 2_000 * 2 ** (n - 1)),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };

  let failed = 0;
  for (let round = 0; round < 40; round++) {
    const all = await db.getAllFromIndex('tasks', 'byRun', runId);
    const active = all.filter((t) => ACTIVE_STATUSES.includes(t.status));
    if (active.length === 0) break;
    for (const t of active) {
      const fresh = await db.get('tasks', t.id);
      if (!fresh || !ACTIVE_STATUSES.includes(fresh.status)) continue;
      const outcome = await runTask(db, fresh, cfg);
      opts.onProgress?.(`${fresh.id.slice(-6)}: ${outcome}`);
    }
  }
  const finalTasks = await db.getAllFromIndex('tasks', 'byRun', runId);
  failed = finalTasks.filter((t) => t.status === 'failed').length;

  const sheet = mergeDefinitions(
    items,
    selected.map((c) => ({ chunkId: c.id, pageStart: c.pageStart, pageEnd: c.pageEnd })),
  );
  await db.put('definitions', {
    docId,
    prepFingerprint: doc.prepFingerprint,
    sheet,
    updatedAt: Date.now(),
  });
  await supabase.from('runs').update({ status: 'complete', updated_at: new Date().toISOString() }).eq('id', runId);
  return { sheet, runId, tasks: finalTasks.length, failed };
}

export async function getDefinitions(db: HarnessDBHandle, docId: string): Promise<DefinitionsSheet | null> {
  const record = await db.get('definitions', docId);
  return record?.sheet ?? null;
}

// Compact text appended to later tasks.
export function definitionsContext(sheet: DefinitionsSheet | null | undefined): string {
  if (!sheet) return '';
  const parties = sheet.parties.length ? `Parties: ${sheet.parties.join('; ')}` : '';
  const terms = sheet.defined_terms
    .map((t) => `${t.term} = ${t.definition}${t.clause ? ` [clause ${t.clause}]` : ''}`)
    .join('; ');
  const dates = sheet.key_dates.map((d) => `${d.date}: ${d.description}`).join('; ');
  return [
    'DEFINITIONS SHEET (from this document):',
    parties,
    terms ? `Defined terms: ${terms}` : '',
    dates ? `Key dates: ${dates}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
