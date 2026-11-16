import { describe, expect, it } from 'vitest';
import { ChatError } from '../chat/stream';
import { buildDocAliases } from './plan';
import { runPlanCall, type PlanStream } from './planCall';
import type { DraftRecord } from './types';

const docs = buildDocAliases([
  { refDocId: 'doc-a', name: 'Lease.pdf', pageCount: 10, available: true },
]);

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: 'draft-1',
    userId: 'user-a',
    title: 'Lease',
    instruction: 'Draft a lease. Use the indemnity from Doc A.',
    referenceDocIds: ['doc-a'],
    reviewingFor: 'neutral',
    status: 'brief',
    particulars: null,
    sourcePlan: null,
    outline: null,
    sourceText: null,
    clauses: {},
    writeRun: null,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const VALID = JSON.stringify({
  docType: 'lease',
  summary: 'A lease using the indemnity from Doc A.',
  lengthHint: null,
  bindings: [
    {
      ref: 'Doc A',
      targetType: 'topic',
      targetValue: 'indemnity',
      useMode: 'verbatim',
      appliesTo: 'indemnity',
      phrase: 'indemnity from Doc A',
    },
  ],
  unresolved: [],
  particulars: [],
  questions: [],
});

function deps(stream: PlanStream) {
  return {
    functionsUrl: 'http://proxy.test/functions/v1',
    anonKey: 'anon',
    getToken: async () => 'token',
    model: 'test-model',
    stream,
  };
}

function streamOf(text: string, finishReason = 'stop'): PlanStream {
  return async (opts) => {
    opts.onDelta(text);
    return { text, finishReason };
  };
}

describe('drafter plan call', () => {
  it('returns the parsed plan and the raw reply', async () => {
    const result = await runPlanCall(deps(streamOf(VALID)), draft(), docs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.docType).toBe('lease');
    expect(result.plan.bindings[0].refDocId).toBe('doc-a');
    expect(result.dropped).toBe(0);
    expect(result.raw).toBe(VALID);
  });

  it('never parses a reply cut at the output limit', async () => {
    const result = await runPlanCall(deps(streamOf(VALID, 'length')), draft(), docs);
    expect(result).toMatchObject({ ok: false, code: 'length' });
    expect(result.raw).toBe(VALID);
  });

  it('treats an empty reply as a visible failure', async () => {
    const result = await runPlanCall(deps(streamOf('', 'stop')), draft(), docs);
    expect(result).toMatchObject({ ok: false, code: 'empty_output' });
  });

  it('accepts one wrapping fence', async () => {
    const result = await runPlanCall(deps(streamOf(`\`\`\`json\n${VALID}\n\`\`\``)), draft(), docs);
    expect(result.ok).toBe(true);
  });

  it('passes the proxy error message through', async () => {
    const failing: PlanStream = async () => {
      throw new ChatError('http_429', 'rate limited by provider');
    };
    const result = await runPlanCall(deps(failing), draft(), docs);
    expect(result).toMatchObject({ ok: false, code: 'http_429', message: 'rate limited by provider' });
  });

  it('reports a network failure without throwing', async () => {
    const failing: PlanStream = async () => {
      throw new Error('offline');
    };
    const result = await runPlanCall(deps(failing), draft(), docs);
    expect(result).toMatchObject({ ok: false, code: 'network', message: 'offline' });
  });
});
