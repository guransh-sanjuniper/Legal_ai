import 'fake-indexeddb/auto';
import { it, expect } from 'vitest';
import { openHarnessDb } from '../runner/db';
import { runAnalysis, restoreReportFromSupabase } from './runAnalysis';
import type { CallRequest, CallResult } from '../tasks/types';
import { STATUTORY_POINT } from './prompts';
import { signIn, seedDocument, scriptedModel } from './testSupport';

it('runs the general analysis, custom pass, missing pass and overview points; restores the report', async () => {
  const db = await openHarnessDb();
  const { sb, token, userId, url, anon } = await signIn();
  const docId = 'stage-a-test';
  await seedDocument(db, docId, 'stage-a-v1');

  let lawCalls = 0;
  const opts = {
    db, supabase: sb, accessToken: token, userId,
    functionsUrl: `${url}/functions/v1`, anonKey: anon, docId, model: 'fake', fallbackModel: null,
    reasoning: { effort: 'minimal' as const }, maxTokens: 2000, autoReduceConcurrency: false,
    lawSearch: async () => { lawCalls++; return []; },
    docSearch: async () => [],
    callModel: async (req: CallRequest): Promise<CallResult> => ({
      text: scriptedModel(req), finishReason: 'stop', provider: 'fake', promptTokens: 10, completionTokens: 10, durationMs: 1,
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

  expect(withPrompt.overviewPoints).toHaveLength(13);
  const statutory = withPrompt.overviewPoints![STATUTORY_POINT - 1].sentences.map((s) => s.text).join(' ');
  expect(statutory).toMatch(/Indian Contract Act 1872 \(model knowledge, applicability unverified\)/);
  expect(statutory).not.toMatch(/Model tried/);
  expect(withPrompt.overviewPoints![3].sentences.length).toBeGreaterThan(0);
  expect(withPrompt.notices).toContain('Law references are model knowledge; their applicability is unverified.');

  expect(withPrompt.promptResult).toBeDefined();
  expect(withPrompt.promptResult!.failedChunks).toEqual([]);
  expect(withPrompt.promptResult!.answers.length).toBeGreaterThan(0);
  for (const a of withPrompt.promptResult!.answers) expect(a).toMatchObject({ verified: true, page: 2 });
  expect(withPrompt.promptResult!.answer?.length).toBeGreaterThan(0);
  expect(withPrompt.promptResult!.answer![0].text).toBe('Clause two states the obligation.');
  expect(withPrompt.riskReview?.reviewed).toBeGreaterThan(0);
  expect(withPrompt.riskReview?.dropped).toBe(0);

  const restored = await restoreReportFromSupabase(sb, docId);
  expect(restored?.runId).toBe(withPrompt.runId);

  const general = await runAnalysis({ ...opts, request: { customPrompt: '   ' } });
  expect(general.promptResult).toBeUndefined();
  expect(general.clauses.map((c) => c.clauseNo)).toEqual(withPrompt.clauses.map((c) => c.clauseNo));
  expect(general.overviewPoints!.map((p) => p.sentences.length)).toEqual(withPrompt.overviewPoints!.map((p) => p.sentences.length));
}, 180_000);
