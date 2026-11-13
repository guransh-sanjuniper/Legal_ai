import { describe, it, expect } from 'vitest';
import MiniSearch from 'minisearch';
import { tokenize } from '../retrieval/tokenize';
import { rrfFuse } from '../retrieval/fusion';

// Evidence for the missing-protection coverage gate. Measures the real search scores on a
// synthetic two-page contract that has a deposit, a notice period and an indemnity, but no
// governing-law clause and no stamp-duty clause.
const PAGES = [
  '1. Term. The Supplier shall deliver the equipment within thirty days of the order.',
  '2. Deposit. The Buyer shall pay a refundable security deposit of two months of the fee.',
  '3. Notice. Either party may end this agreement by giving sixty days written notice.',
  '4. Indemnity. The Supplier shall indemnify the Buyer against third-party claims.',
];

const windows = PAGES.map((text, i) => ({ id: `w${i}`, text }));

function keywordScores(query: string) {
  const index = new MiniSearch({
    idField: 'id',
    fields: ['text'],
    storeFields: ['text'],
    tokenize,
    searchOptions: { tokenize, prefix: true, fuzzy: 0.1 },
  });
  index.addAll(windows);
  return index.search(query).map((r) => ({ id: String(r.id), score: r.score }));
}

// The real vector search ranks every window (dense), so a rank-1 always exists even for an
// absent topic. This mirrors that list to show what fused alone can prove.
const denseList = windows.map((w, i) => ({ id: w.id, score: windows.length - i }));

const fusedFor = (query: string) => {
  const kw = keywordScores(query);
  const fused = rrfFuse([denseList, kw.map((r) => ({ id: r.id, score: r.score }))]);
  return { kw, bestFused: Math.max(...fused.values()) };
};

describe('coverage gate: measured search scores on a two-page contract', () => {
  it('present topics have a keyword hit', () => {
    for (const q of ['deposit', 'notice', 'indemnity']) {
      expect(keywordScores(q).length, q).toBeGreaterThan(0);
    }
  });

  it('absent topics have no keyword hit', () => {
    for (const q of ['governing law', 'stamp duty']) {
      expect(keywordScores(q), q).toEqual([]);
    }
  });

  it('fused scores are tiny and an absent topic still has a positive fused score', () => {
    const present = fusedFor('deposit');
    const absent = fusedFor('governing law');
    // RRF spans roughly 1/110 to 2/61 (about 0.009 to 0.033). No fixed cutoff in that range
    // can separate present from absent, because the dense vector list always contributes.
    expect(absent.bestFused).toBeGreaterThan(0);
    expect(absent.bestFused).toBeCloseTo(1 / 61, 5);
    expect(present.bestFused).toBeGreaterThan(absent.bestFused);
    expect(present.bestFused).toBeLessThan(0.05);
  });
});
