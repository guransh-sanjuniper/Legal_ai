import { supabase, supabaseAnonKey, supabaseUrl } from '../../lib/supabase';
import type { AnalysisRequest } from '../../analysis/types';
import type { DocumentRecord } from '../../runner/db';

// Same token handling as the dev analysis page: refresh when forced, otherwise the current session.
export async function freshToken(force = false): Promise<string | null> {
  if (!supabase) return null;
  if (force) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session) return data.session.access_token;
  }
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export function functionsEndpoint(): { functionsUrl: string; anonKey: string } {
  return { functionsUrl: `${supabaseUrl}/functions/v1`, anonKey: supabaseAnonKey };
}

// The run the page is working on. Stored per document so a reload can resume or retry it.
export interface RunRecord {
  runId: string;
  request: AnalysisRequest;
  startedAt: number;
}

const recordKey = (docId: string) => `legal-app.analysis.${docId}`;

export function readRunRecord(docId: string): RunRecord | null {
  try {
    const raw = localStorage.getItem(recordKey(docId));
    return raw ? (JSON.parse(raw) as RunRecord) : null;
  } catch {
    return null;
  }
}

export function writeRunRecord(docId: string, record: RunRecord | null): void {
  if (record) localStorage.setItem(recordKey(docId), JSON.stringify(record));
  else localStorage.removeItem(recordKey(docId));
}

// Takes the document lock that preparation and removal also use. Returns false when another run
// (or preparation) already holds it, so two runs never work on one document.
export async function withDocumentLock<T>(
  doc: DocumentRecord,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!navigator.locks?.request) return { ran: true, value: await fn() };
  const result = await navigator.locks.request(`doc:${doc.hash}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return { ran: false as const };
    return { ran: true as const, value: await fn() };
  });
  return result;
}

// Human label for a task id. The suffix letter names the pass; see execute.ts and runAnalysis.ts.
export function taskLabel(taskId: string): string {
  const suffix = taskId.slice(taskId.lastIndexOf(':') + 1).split('/')[0];
  const kind = /^[a-z]+/.exec(suffix)?.[0] ?? suffix;
  const labels: Record<string, string> = {
    a: 'Clause analysis',
    r: 'Clause retry (missing clauses)',
    x: 'Clause retry (backoff)',
    c: 'Custom prompt',
    cx: 'Custom prompt retry',
    m: 'Missing protections',
    ov: 'Overview',
    s: 'Section summary',
  };
  return labels[kind] ?? 'Task';
}
