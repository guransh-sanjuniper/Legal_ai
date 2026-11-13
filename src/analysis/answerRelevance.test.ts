import { describe, it, expect } from 'vitest';
import {
  batchRejected,
  buildRelevanceInput,
  isValidRelevanceVerdict,
  judgeRejectedAnswers,
  parseRelevanceVerdict,
  RELEVANCE_BATCH,
} from './answerRelevance';
import type { PromptAnswer } from './types';

const ans = (id: string, quote = `quote ${id}`): PromptAnswer => ({
  itemId: id, text: quote, clause: '7', page: 3, quote, verified: true, part: 'answer',
});

describe('batchRejected', () => {
  it('puts up to ten quotes in one batch', () => {
    expect(batchRejected(Array.from({ length: 3 }, (_, i) => i))).toEqual([[0, 1, 2]]);
  });

  it('splits twelve quotes into two batches, so cost grows per ten quotes, not per quote', () => {
    const batches = batchRejected(Array.from({ length: 12 }, (_, i) => i));
    expect(batches.length).toBe(2);
    expect(batches[0]).toHaveLength(RELEVANCE_BATCH);
    expect(batches[1]).toHaveLength(2);
  });

  it('makes no batch for no quotes', () => {
    expect(batchRejected([])).toEqual([]);
  });
});

describe('parseRelevanceVerdict', () => {
  it('reads yes and no in any case, with a trimmed reason', () => {
    expect(parseRelevanceVerdict({ id: 'P1', verdict: 'YES', reason: ' states the handover date ' })).toEqual({
      id: 'P1', verdict: 'yes', reason: 'states the handover date',
    });
    expect(parseRelevanceVerdict({ id: 'P2', verdict: 'no', reason: 'a rate table' })?.verdict).toBe('no');
  });

  it('rejects a verdict that is not yes or no, or has no reason', () => {
    expect(isValidRelevanceVerdict({ id: 'P1', verdict: 'maybe', reason: 'x' })).toBe(false);
    expect(isValidRelevanceVerdict({ id: 'P1', verdict: 'yes', reason: '  ' })).toBe(false);
    expect(isValidRelevanceVerdict({ verdict: 'yes', reason: 'x' })).toBe(false);
    expect(isValidRelevanceVerdict(null)).toBe(false);
  });
});

describe('buildRelevanceInput', () => {
  it('gives the request and the quotes with their ids, clause and page', () => {
    const input = buildRelevanceInput('When is the handover date?', [ans('P4', 'Possession shall be given on 1 May.')]);
    expect(input).toContain('USER REQUEST: When is the handover date?');
    expect(input).toContain('"id":"P4"');
    expect(input).toContain('Possession shall be given on 1 May.');
  });
});

describe('judgeRejectedAnswers', () => {
  it('makes no call when nothing was rejected', async () => {
    let calls = 0;
    const out = await judgeRejectedAnswers({ rejected: [], ask: async () => { calls++; return []; } });
    expect(calls).toBe(0);
    expect(out.stats.calls).toBe(0);
    expect(out.approved.size).toBe(0);
  });

  it('keeps a yes with its reason, and leaves a no rejected', async () => {
    const out = await judgeRejectedAnswers({
      rejected: [ans('P1'), ans('P2')],
      ask: async () => [
        { id: 'P1', verdict: 'yes', reason: 'possession date is the handover date' },
        { id: 'P2', verdict: 'no', reason: 'a rate table' },
      ],
    });
    expect(out.approved.get('P1')).toBe('possession date is the handover date');
    expect(out.approved.has('P2')).toBe(false);
    expect(out.stats).toMatchObject({ checked: 2, kept: 1, rejected: 1, calls: 1 });
    expect(out.stats.decisions.map((d) => d.verdict)).toEqual(['yes', 'no']);
  });

  it('leaves a quote with no verdict rejected and marks it unchecked', async () => {
    const out = await judgeRejectedAnswers({ rejected: [ans('P1'), ans('P2')], ask: async () => [{ id: 'P1', verdict: 'yes', reason: 'ok' }] });
    expect(out.approved.has('P2')).toBe(false);
    expect(out.stats.decisions[1].verdict).toBe('unchecked');
  });

  it('fails closed when the call throws: every quote stays rejected and the error is kept', async () => {
    const out = await judgeRejectedAnswers({ rejected: [ans('P1')], ask: async () => { throw new Error('http_500'); } });
    expect(out.approved.size).toBe(0);
    expect(out.stats.kept).toBe(0);
    expect(out.stats.error).toContain('http_500');
    expect(out.stats.decisions[0].verdict).toBe('unchecked');
  });

  it('sends ten quotes per batch and reports the calls', async () => {
    const seen: number[] = [];
    const rejected = Array.from({ length: 12 }, (_, i) => ans(`P${i + 1}`));
    const out = await judgeRejectedAnswers({
      rejected,
      ask: async (batches) => {
        seen.push(...batches.map((b) => b.length));
        return [];
      },
    });
    expect(seen).toEqual([10, 2]);
    expect(out.stats.calls).toBe(2);
    expect(out.stats.checked).toBe(12);
  });
});
