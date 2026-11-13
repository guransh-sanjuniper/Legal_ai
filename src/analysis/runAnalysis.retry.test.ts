import 'fake-indexeddb/auto';
import { it, expect } from 'vitest';
import { openHarnessDb } from '../runner/db';
import { runAnalysis } from './runAnalysis';
import { CallError, type CallRequest, type CallResult } from '../tasks/types';
import { signIn, seedDocument, scriptedModel } from './testSupport';

const taskSuffix = (id: string, runId: string) => id.slice(runId.length + 1).split('/')[0];

it('retry failed re-runs only the failed tasks, including the custom pass, then rebuilds the report', async () => {
  const db = await openHarnessDb();
  const { sb, token, userId, url, anon } = await signIn();
  const docId = 'retry-test';
  await seedDocument(db, docId, 'retry-v1');

  let failing = true;
  let calls = 0;
  const callModel = async (req: CallRequest): Promise<CallResult> => {
    calls++;
    const touchesPageOne = req.input.includes('[[p1]]');
    const clauseOrCustom = req.prompt.includes('Return exactly ONE item') || req.prompt.includes('USER REQUEST:');
    if (failing && touchesPageOne && clauseOrCustom) throw new CallError('http_400', 'forced failure for the retry test');
    return { text: scriptedModel(req), finishReason: 'stop', provider: 'fake', promptTokens: 10, completionTokens: 10, durationMs: 1 };
  };
  const opts = {
    db, supabase: sb, accessToken: token, userId,
    functionsUrl: `${url}/functions/v1`, anonKey: anon, docId, model: 'fake', fallbackModel: null,
    reasoning: { effort: 'minimal' as const }, maxTokens: 2000, autoReduceConcurrency: false,
    lawSearch: async () => [], docSearch: async () => [], callModel,
    request: { customPrompt: 'Which clause says what the Developer must perform?' },
  };

  const first = await runAnalysis(opts);
  const failedFirst = (await db.getAllFromIndex('tasks', 'byRun', first.runId)).filter((t) => t.status === 'failed');
  expect(failedFirst.length).toBeGreaterThan(0);
  expect(first.partial).toBe(true);
  // Inline prompt answers ride in the clause call, so a failed clause is the only failed part.
  expect(first.promptResult?.mode).toBe('inline');

  // Only the first-pass clause tasks are re-planned, so only they can be called again.
  const expectedReruns = failedFirst.filter((t) => /^a\d+$/.test(taskSuffix(t.id, first.runId))).length;
  expect(expectedReruns).toBeGreaterThan(0);

  // Simulate tasks stored with older prompts: retry must refresh them from the current template,
  // including a failed summary pass.
  const beforeTasks = await db.getAllFromIndex('tasks', 'byRun', first.runId);
  const oldPs = beforeTasks.find((t) => t.id.endsWith(':ps'));
  if (oldPs) await db.put('tasks', { ...oldPs, prompt: 'OLD PROMPT', promptVersion: 'old' });
  const oldEs = beforeTasks.find((t) => t.id.endsWith(':es'));
  if (oldEs) {
    await db.put('tasks', { ...oldEs, status: 'failed', failureCode: 'bad_json', prompt: 'OLD PROMPT', promptVersion: 'old' });
  }
  const before = new Set(beforeTasks.map((t) => t.id));
  const attemptsBefore = new Map(beforeTasks.map((t) => [t.id, t.attemptNo]));
  failing = false;
  calls = 0;
  const second = await runAnalysis({ ...opts, resumeRunId: first.runId, retryFailed: true });

  expect(second.runId).toBe(first.runId);
  // Retried tasks, plus any pass that could only start once the previously failed page had clauses.
  const after = await db.getAllFromIndex('tasks', 'byRun', first.runId);
  const newDone = after.filter((t) => !before.has(t.id) && t.status === 'done').length;
  const reran = after.filter((t) => before.has(t.id) && t.attemptNo > (attemptsBefore.get(t.id) ?? 0)).length;
  expect(calls).toBe(reran + newDone);
  expect((await db.getAllFromIndex('tasks', 'byRun', first.runId)).filter((t) => t.status === 'failed' && /^a\d+$/.test(taskSuffix(t.id, first.runId)))).toHaveLength(0);
  expect(second.failedClauses).toEqual([]);
  expect(second.partial).toBe(false);
  expect(second.promptResult?.failedChunks).toEqual([]);
  expect(second.promptResult?.answers.length).toBeGreaterThan(0);
  const afterTasks = await db.getAllFromIndex('tasks', 'byRun', first.runId);
  const psAfterTask = afterTasks.find((t) => t.id.endsWith(':ps'));
  expect(psAfterTask?.prompt).toMatch(/entire reply is one JSON array/);
  expect(psAfterTask?.promptVersion).toBe('prompt-synthesis-v4');
  const esAfterTask = afterTasks.find((t) => t.id.endsWith(':es'));
  if (esAfterTask) {
    expect(esAfterTask.prompt).toMatch(/entire reply is one JSON array/);
    expect(esAfterTask.promptVersion).toBe('executive-summary-v1');
    expect(esAfterTask.status).not.toBe('failed');
  }
  expect(second.clauses.some((c) => c.pageStart === 1)).toBe(true);
}, 180_000);
