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
    // A weak, vector-only hit: the claim is kept as verified missing, never counted as coverage.
    docSearch: async () => [{ pageStart: 1, pageEnd: 1, fused: 1 / 61, keywordScore: 0 }],
    callModel: async (req: CallRequest): Promise<CallResult> => ({
      text: scriptedModel(req), finishReason: 'stop', provider: 'fake', promptTokens: 10, completionTokens: 10, durationMs: 1,
    }),
  };

  const withPrompt = await runAnalysis({
    ...opts,
    request: { detailLevel: 'brief', focus: 'notice and exit', customPrompt: 'Which clause says what the Developer must perform?' },
  });

  expect(lawCalls).toBe(0);
  expect(withPrompt.request).toMatchObject({ detailLevel: 'brief', focus: 'notice and exit' });

  const risks = withPrompt.clauses.flatMap((c) => c.risks);
  expect(risks.length).toBeGreaterThan(0);
  for (const r of risks) {
    expect(r.affects && r.affects !== 'Not identified').toBe(true);
    expect(r.severity).toBe('medium');
    expect(r.suggestion?.length ?? 0).toBeGreaterThan(0);
    expect(r.lawPassages).toBeUndefined();
  }
  const modelRisks = risks.filter((r) => !/left blank/.test(r.text));
  for (const r of modelRisks) {
    expect(r.suggestion).toBe('Negotiate mutual terms.');
    expect(r.laws).toEqual(['Indian Contract Act 1872']);
  }
  const blankRisk = risks.find((r) => /left blank/.test(r.text));
  expect(blankRisk).toMatchObject({ severity: 'medium' });
  expect(blankRisk!.suggestion).toMatch(/Fill the blank/);
  expect(withPrompt.clauses[0].missing).toEqual(['No notice period']);
  expect(withPrompt.clauses[0].prose?.detailed_summary).toBe('Detailed text.');

  expect(withPrompt.missingProtections).toHaveLength(1);
  expect(withPrompt.missingStats).toMatchObject({ kept: 1, possiblyMissing: 0, passRan: true, rawItems: 2, rejectedBySchema: 1 });
  expect(withPrompt.possiblyMissing).toEqual([]);
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
  for (const a of withPrompt.promptResult!.answers) {
    expect(a.verified).toBe(true);
    expect(a.page).toBeGreaterThanOrEqual(1);
    expect(a.page).toBeLessThanOrEqual(4);
  }
  expect(withPrompt.promptResult!.mode).toBe('inline');
  // No separate per-chunk prompt pass: those tasks have a "c" suffix.
  const promptTasks = (await db.getAllFromIndex('tasks', 'byRun', withPrompt.runId)).filter((t) => /:(?:c|cx)\d+/.test(t.id));
  expect(promptTasks).toHaveLength(0);
  expect(withPrompt.promptResult!.answer?.length).toBeGreaterThan(0);
  expect(withPrompt.promptResult!.answer![0].text).toBe('Clause two states the obligation.');
  expect(withPrompt.riskReview?.reviewed).toBeGreaterThan(0);
  expect(withPrompt.riskReview?.dropped).toBe(0);

  // Points 8 and 9 are written from focused evidence; point 11 lists the blanks; the summary is cited.
  expect(withPrompt.overviewPoints![7].sentences.length).toBeGreaterThan(0);
  expect(withPrompt.overviewPoints![8].sentences.length).toBeGreaterThan(0);
  expect(withPrompt.overviewPoints![10].sentences[0]?.text).toMatch(/Unfilled blanks \(1\)/);
  expect(withPrompt.draftingIssues?.blankCount).toBe(1);
  expect(withPrompt.overviewPoints![12].sentences.length).toBeGreaterThan(0);
  expect(withPrompt.summaryStats?.kept).toBeGreaterThan(0);

  const restored = await restoreReportFromSupabase(sb, docId);
  expect(restored?.runId).toBe(withPrompt.runId);

  const general = await runAnalysis({ ...opts, request: { customPrompt: '   ' } });
  expect(general.promptResult).toBeUndefined();
  // The general sections and items must be identical with and without a prompt.
  // This holds for the scripted model; a real model can differ slightly.
  expect(JSON.stringify(general.clauses)).toEqual(JSON.stringify(withPrompt.clauses));
  expect(JSON.stringify(general.overviewPoints)).toEqual(JSON.stringify(withPrompt.overviewPoints));
  expect(general.overviewPoints!.map((p) => p.sentences.length)).toEqual(withPrompt.overviewPoints!.map((p) => p.sentences.length));
}, 180_000);
