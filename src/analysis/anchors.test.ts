import { describe, it, expect } from 'vitest';
import { buildAnchorIndex, continuesSubSequence, subItemOrdinal } from './anchors';

const letterLabels = 'abcdefghijklmnopqrstuvwxyz'.split('');

describe('sub-item label values', () => {
  it('runs a..z then continues with aa, bb, ... hh', () => {
    expect(subItemOrdinal('a')).toBe(1);
    expect(subItemOrdinal('z')).toBe(26);
    expect(subItemOrdinal('aa')).toBe(27);
    expect(subItemOrdinal('bb')).toBe(28);
    expect(subItemOrdinal('hh')).toBe(34);
  });

  it('accepts only the first label or the next one', () => {
    expect(continuesSubSequence(null, 'a')).toBe(true);
    expect(continuesSubSequence(null, 'b')).toBe(false);
    expect(continuesSubSequence(26, 'aa')).toBe(true);
    expect(continuesSubSequence(26, 'ab')).toBe(false);
    expect(continuesSubSequence(33, 'hh')).toBe(true);
    expect(continuesSubSequence(33, 'hhh')).toBe(false);
  });

  it('handles numeric sub-items by value', () => {
    expect(subItemOrdinal('7')).toBe(7);
    expect(continuesSubSequence(6, '7')).toBe(true);
  });
});

describe('anchor labels for long lettered runs (synthetic text)', () => {
  const longRun = [
    ...letterLabels.map((l) => `${l}) sub item ${l} with enough text to be a line.`),
    ...['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh'].map(
      (l) => `${l}) sub item ${l} that follows the end of the alphabet.`,
    ),
  ].join('\n');

  const pages = new Map<number, string>([
    [1, `30) Obligations of a party\nintroductory text for the clause.\n${longRun}\n31) Next clause\nbody text`],
  ]);

  it('labels every sub-item, including the multi-letter ones', () => {
    const labels = buildAnchorIndex(pages).segments.map((s) => s.clause);
    expect(labels).toContain('30(a)');
    expect(labels).toContain('30(z)');
    expect(labels).toContain('30(aa)');
    expect(labels).toContain('30(hh)');
    expect(labels).not.toContain('31(aa)');
  });

  it('accepts a label with no space after the bracket', () => {
    const text = '5) Clause\nintro.\na)first sub item with text.\nb)second sub item with text.\n6) Next\nbody';
    expect(buildAnchorIndex(new Map([[1, text]])).segments.map((s) => s.clause)).toContain('5(b)');
  });

  it('ignores a label that does not continue the run', () => {
    const text = '5) Clause\nintro.\na) first sub item with text.\nzz) not a continuation.\nb) second sub item with text.\n6) Next\nbody';
    const segs = buildAnchorIndex(new Map([[1, text]])).segments;
    expect(segs.map((s) => s.clause)).toContain('5(b)');
    expect(segs.map((s) => s.clause)).not.toContain('5(zz)');
  });
});
