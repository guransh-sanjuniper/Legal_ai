import { describe, expect, it } from 'vitest';
import { ChatError } from '../chat/stream';
import { buildDocAliases } from './plan';
import { runOutlineCall } from './outlineCall';
import type { PlanStream } from './planCall';
import type { DraftRecord, SourcePlan } from './types';

const docs = buildDocAliases([{ refDocId: 'doc-a', name: 'Lease.pdf', pageCount: 10, available: true }]);

const plan: SourcePlan = {
  docType: 'lease',
  summary: 'A lease.',
  lengthHint: 'short',
  referenceMode: 'specific',
  bindings: [
    {
      id: 'bind-1',
      refDocId: 'doc-a',
      target: { type: 'clause', value: '14' },
      useMode: 'adapt',
      appliesTo: 'indemnity',
      phrase: 'indemnity from Doc A',
    },
  ],
  unresolved: [],
  questions: [],
  parsedAt: '2026-01-01T00:00:00.000Z',
  model: 'plan-model',
  parsedFrom: { instruction: 'Draft a lease.', referenceDocIds: ['doc-a'] },
};

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: 'draft-1',
    userId: 'user-a',
    title: 'Lease',
    instruction: 'Draft a lease using the indemnity from Doc A.',
    referenceDocIds: ['doc-a'],
    reviewingFor: 'neutral',
    status: 'planned',
    particulars: null,
    sourcePlan: plan,
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
  notes: 'Short structure.',
  items: [
    { level: 1, title: 'Parties', purpose: 'Who the lease is between', kind: 'preamble', bindings: [] },
    { level: 1, title: 'Indemnity', purpose: 'Who covers what', kind: 'clause', bindings: ['B1'] },
  ],
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

describe('drafter outline call', () => {
  it('returns the parsed outline and the raw reply', async () => {
    const result = await runOutlineCall(deps(streamOf(VALID)), draft(), docs, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline.items).toHaveLength(2);
    expect(result.outline.items[1].bindingIds).toEqual(['bind-1']);
    expect(result.outline.planFingerprint).toHaveLength(16);
    expect(result.dropped).toBe(0);
    expect(result.raw).toBe(VALID);
  });

  it('never parses a reply cut at the output limit', async () => {
    const result = await runOutlineCall(deps(streamOf(VALID, 'length')), draft(), docs, []);
    expect(result).toMatchObject({ ok: false, code: 'length' });
    expect(result.raw).toBe(VALID);
  });

  it('treats an empty reply as a visible failure', async () => {
    const result = await runOutlineCall(deps(streamOf('', 'stop')), draft(), docs, []);
    expect(result).toMatchObject({ ok: false, code: 'empty_output' });
  });

  it('reports bad JSON without throwing', async () => {
    const result = await runOutlineCall(deps(streamOf('not json', 'stop')), draft(), docs, []);
    expect(result).toMatchObject({ ok: false, code: 'bad_json' });
  });

  it('accepts one wrapping fence', async () => {
    const result = await runOutlineCall(deps(streamOf(`\`\`\`json\n${VALID}\n\`\`\``)), draft(), docs, []);
    expect(result.ok).toBe(true);
  });

  it('passes the proxy error message through', async () => {
    const failing: PlanStream = async () => {
      throw new ChatError('http_429', 'rate limited by provider');
    };
    const result = await runOutlineCall(deps(failing), draft(), docs, []);
    expect(result).toMatchObject({ ok: false, code: 'http_429', message: 'rate limited by provider' });
  });
});
