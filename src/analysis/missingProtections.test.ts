import { describe, it, expect } from 'vitest';
import {
  coreTerms,
  hitCoversTopic,
  isValidMissingItem,
  keepMissingClaims,
  missingGroups,
  missingPlanFor,
  missingPlans,
  readMissingItem,
} from './missingProtections';
import { NO_SUGGESTION } from './rubric';

const none = async () => [];
// A keyword hit: the topic's words occur on a page. Its fused score is at least 1/110.
const keywordHit = async (topic: string) => [{ fused: 1 / 61, keywordScore: 2.1, windowText: `${topic} clause` }];
// A weak vector-only hit: no keyword match, only the dense list ranked it.
const vectorOnly = async () => [{ fused: 1 / 61, keywordScore: 0 }];

describe('coverage gate: the topic\'s own words', () => {
  const hit = (windowText: string) => [{ fused: 1 / 61, keywordScore: 2, windowText }];

  it('accepts the full phrase', () => {
    expect(hitCoversTopic(hit('Clause 9: this agreement is governed by the laws of India; governing law and jurisdiction lie in Pune.'), 'governing law')).toBe(true);
  });

  it('does not accept a hit that contains only a generic word', () => {
    expect(hitCoversTopic(hit('The parties shall comply with the law from time to time.'), 'governing law')).toBe(false);
    expect(hitCoversTopic(hit('The parties record the governing of the site.'), 'jurisdiction')).toBe(false);
  });

  it('matches core terms by stem: refund covers refund mechanics, indemnity covers indemnify', () => {
    expect(hitCoversTopic(hit('The deposit refund will be processed within 30 days.'), 'refund mechanics')).toBe(true);
    expect(hitCoversTopic(hit('The Supplier shall indemnify the Buyer against claims.'), 'indemnity')).toBe(true);
  });

  it('keeps only non-generic core terms', () => {
    expect(coreTerms('who pays duties')).toEqual(['duties']);
  });
});

describe('tolerant item shape', () => {
  it('accepts title/description aliases and string trimming', () => {
    expect(readMissingItem({ title: ' indemnity ', description: 'No indemnity clause.' })).toEqual({
      topic: 'indemnity',
      text: 'No indemnity clause.',
    });
    expect(isValidMissingItem({ protection: 'forum', detail: 'No forum.' })).toBe(true);
  });

  it('rejects an unusable item so it is counted, not hidden', () => {
    expect(isValidMissingItem({ topic: 'governing law' })).toBe(false);
    expect(isValidMissingItem({ text: 'No text field.' })).toBe(false);
    expect(isValidMissingItem('governing law')).toBe(false);
  });
});

describe('missing plans', () => {
  it('builds one plan per group and can split a group into two smaller calls', () => {
    const clauses = Array.from({ length: 80 }, (_, i) => ({ id: `C${i}`, clause: String(i), type: 'other', summary: 's' }));
    const groups = missingGroups(clauses);
    expect(groups.length).toBeGreaterThan(1);
    const opts = { defsContext: 'defs', focus: '', docType: 'lease' as const, reviewingFor: 'neutral' as const, present: ['1'] };
    const full = missingPlanFor(groups[0], 'm0', opts);
    expect(full.maxTokens).toBe(2000);
    const mid = Math.ceil(groups[0].length / 2);
    const half = missingPlanFor(groups[0].slice(0, mid), 'm0s0', opts);
    expect(half.input.length).toBeLessThan(full.input.length);
  });
});

describe('missing protections', () => {
  it('keeps a claim only when the document search finds nothing', async () => {
    const items = [
      { topic: 'governing law', text: 'No governing law clause.', priority: 'medium', basis: 'other', suggestion: 'Add one.', laws: ['Indian Contract Act 1872'], cites: ['C1:1:1'] },
      { topic: 'notice period', text: 'No notice period.', priority: 'high', basis: 'illegal', suggestion: 'Add one.', laws: [], cites: [] },
    ];
    const weak = { fused: 1 / 61, keywordScore: 0 };
    const kept = await keepMissingClaims(items, new Set(['C1:1:1']), async (q) => (q === 'notice period' ? [weak] : keywordHit(q)));
    expect(kept.kept.map((m) => m.topic)).toEqual(['notice period']);
    expect(kept.coveredInDocument).toBe(1);
    expect(kept.kept[0]).toMatchObject({ itemId: 'M1', severity: 'high', applicability: 'unverified' });
    expect(kept.proposed).toBe(2);
  });

  it('drops a claim whose search fails rather than showing it as checked', async () => {
    const boom = async () => {
      throw new Error('search down');
    };
    const r = await keepMissingClaims([{ topic: 'x', text: 'y', priority: 'low', basis: 'other', suggestion: 's', laws: [], cites: [] }], new Set(), boom);
    expect(r.kept).toEqual([]);
    expect(r.possiblyMissing).toHaveLength(1);
    expect(r.unchecked).toBe(1);
  });

  it('keeps only valid clause cites and a visible fallback for a missing suggestion', async () => {
    const r = await keepMissingClaims(
      [{ topic: 'deposit', text: 'No deposit refund.', priority: 'low', basis: 'other', cites: ['C1:1:1', 'ghost'] }],
      new Set(['C1:1:1']),
      vectorOnly,
    );
    expect(r.kept[0].cites).toEqual(['C1:1:1']);
    expect(r.kept[0].suggestion).toBe(NO_SUGGESTION);
  });

  it('dedupes topics and ignores invalid items', async () => {
    const r = await keepMissingClaims(
      [
        { topic: 'Insurance', text: 'a', priority: 'low', basis: 'other', suggestion: 's', laws: [], cites: [] },
        { topic: 'insurance', text: 'b', priority: 'low', basis: 'other', suggestion: 's', laws: [], cites: [] },
        { topic: 42, text: 'bad' },
      ],
      new Set(),
      vectorOnly,
    );
    expect(r.kept).toHaveLength(1);
  });

  it('keeps a claim apart as possibly missing when the search returns nothing', async () => {
    const r = await keepMissingClaims(
      [{ topic: 'indemnity', text: 'No indemnity.', priority: 'medium', basis: 'other', suggestion: 'Add one.' }],
      new Set(),
      none,
    );
    expect(r.kept).toEqual([]);
    expect(r.possiblyMissing.map((m) => m.topic)).toEqual(['indemnity']);
    expect(r.proposed).toBe(1);
  });

  it('treats a keyword hit as coverage, so the claim is dropped', async () => {
    const r = await keepMissingClaims([{ topic: 'deposit', text: 't', priority: 'low', basis: 'other', suggestion: 's' }], new Set(), (q) => keywordHit(q));
    expect(r.kept).toEqual([]);
    expect(r.coveredInDocument).toBe(1);
  });

  it('does not let a weak vector-only hit drop a genuinely missing claim', async () => {
    const r = await keepMissingClaims([{ topic: 'governing law', text: 't', priority: 'medium', basis: 'other', suggestion: 's' }], new Set(), vectorOnly);
    expect(r.kept.map((m) => m.topic)).toEqual(['governing law']);
    expect(r.coveredInDocument).toBe(0);
  });

  it('splits clauses into small task groups with the focus in the prompt', () => {
    const clauses = Array.from({ length: 70 }, (_, i) => ({ id: `C${i}`, clause: String(i), type: 'other', summary: 's' }));
    const plans = missingPlans(clauses, 'defs', 'deposits');
    expect(plans.length).toBeGreaterThan(1);
    expect(plans[0].prompt).toMatch(/deposits/);
    expect(isValidMissingItem({ topic: 't', text: 'x' })).toBe(true);
  });
});
