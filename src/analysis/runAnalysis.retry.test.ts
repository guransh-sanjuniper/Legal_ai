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
    request: { customPrompt: 'Which clause states the obligation?' },
  };

  const first = await runAnalysis(opts);
  const failedFirst = (await db.getAllFromIndex('tasks', 'byRun', first.runId)).filter((t) => t.status === 'failed');
  expect(failedFirst.length).toBeGreaterThan(0);
  expect(first.partial).toBe(true);
  expect(first.promptResult?.failedChunks.length).toBeGreaterThan(0);

  // Only the first-pass clause and custom tasks are re-planned, so only they can be called again.
  const expectedReruns = failedFirst.filter((t) => /^(a|c)\d+$/.test(taskSuffix(t.id, first.runId))).length;
  expect(expectedReruns).toBeGreaterThan(0);

  const before = new Set((await db.getAllFromIndex('tasks', 'byRun', first.runId)).map((t) => t.id));
  failing = false;
  calls = 0;
  const second = await runAnalysis({ ...opts, resumeRunId: first.runId, retryFailed: true });

  expect(second.runId).toBe(first.runId);
  // Retried tasks, plus any pass that could only start once the previously failed page had clauses.
  const after = await db.getAllFromIndex('tasks', 'byRun', first.runId);
  const newDone = after.filter((t) => !before.has(t.id) && t.status === 'done').length;
  expect(calls).toBe(expectedReruns + newDone);
  expect((await db.getAllFromIndex('tasks', 'byRun', first.runId)).filter((t) => t.status === 'failed' && /^(a|c)\d+$/.test(taskSuffix(t.id, first.runId)))).toHaveLength(0);
  expect(second.failedClauses).toEqual([]);
  expect(second.partial).toBe(false);
  expect(second.promptResult?.failedChunks).toEqual([]);
  expect(second.promptResult?.answers.length).toBeGreaterThan(0);
  expect(second.clauses.some((c) => c.pageStart === 1)).toBe(true);
}, 180_000);
