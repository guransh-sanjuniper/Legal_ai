import { describe, it, expect } from 'vitest';
import { rrfFuse, rankedFusion, filterWeak } from './fusion';

describe('reciprocal rank fusion', () => {
  it('adds 1/(k+rank+1) for each list', () => {
    const fused = rrfFuse([[{ id: 'a', score: 9 }, { id: 'b', score: 8 }], [{ id: 'b', score: 1 }]], 60);
    expect(fused.get('a')).toBeCloseTo(1 / 61);
    expect(fused.get('b')).toBeCloseTo(1 / 62 + 1 / 61);
  });

  it('ranks an item found by both lists above an item found by one', () => {
    const ranked = rankedFusion([
      [{ id: 'only-vector', score: 0.9 }, { id: 'both', score: 0.8 }],
      [{ id: 'both', score: 3 }, { id: 'only-keyword', score: 2 }],
    ]);
    expect(ranked[0].id).toBe('both');
    expect(ranked.map((r) => r.id)).toEqual(['both', 'only-vector', 'only-keyword']);
  });

  it('is scale free: large score gaps do not matter, only rank', () => {
    const a = rankedFusion([[{ id: 'x', score: 1000 }, { id: 'y', score: 1 }]]);
    const b = rankedFusion([[{ id: 'x', score: 1 }, { id: 'y', score: 0.99 }]]);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });

  it('uses a stable id tiebreak', () => {
    const ranked = rankedFusion([[{ id: 'b', score: 1 }], [{ id: 'a', score: 1 }]]);
    expect(ranked.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('weak result filtering', () => {
  it('drops results far below the best, so no top-k is forced', () => {
    const out = filterWeak([{ id: 'a', score: 1 }, { id: 'b', score: 0.5 }, { id: 'c', score: 0.1 }], 0.35);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('handles an empty list', () => {
    expect(filterWeak([], 0.35)).toEqual([]);
  });
});
