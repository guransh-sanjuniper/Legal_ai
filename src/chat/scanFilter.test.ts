import { describe, it, expect } from 'vitest';
import type { AnalysisChunk } from '../analysis/analysisChunks';
import { wholeChunks } from '../analysis/promptOnReport';
import { scanNote, selectChunksForQuestion } from './scanFilter';

const chunk = (index: number, text: string) => ({ index, text, pageMarkedText: text }) as unknown as AnalysisChunk;

const sections = [
  chunk(0, 'The tenant pays a refundable deposit on signing.'),
  chunk(1, 'Repairs to the roof are the landlord responsibility.'),
  chunk(2, 'This agreement is governed by the laws of the state.'),
  chunk(3, 'The lessee may terminate with ninety days notice.'),
];

describe('selectChunksForQuestion', () => {
  it('always scans a section that contains a question term', () => {
    const s = selectChunksForQuestion(sections, 'what is the deposit?');
    expect(s.chunks.map((c) => c.index)).toContain(0);
  });

  it('skips a section that contains none of the terms', () => {
    const s = selectChunksForQuestion(sections, 'what is the deposit?');
    expect(s.chunks.map((c) => c.index)).toEqual([0]);
    expect(s.reason).toBe('terms');
  });

  it('matches by a loose prefix, so termination finds terminate', () => {
    const s = selectChunksForQuestion(sections, 'what are the termination rights?');
    expect(s.chunks.map((c) => c.index)).toEqual([3]);
  });

  it('scans every section when the question has no terms', () => {
    const s = selectChunksForQuestion(sections, 'what is this?');
    expect(s.terms).toEqual([]);
    expect(s.chunks).toHaveLength(sections.length);
    expect(s.reason).toBe('no-terms');
    expect(s.skipped).toBe(0);
  });

  it('scans every section when no section contains any term', () => {
    const s = selectChunksForQuestion(sections, 'what is the arbitration venue?');
    expect(s.terms).toEqual(['arbitration', 'venue']);
    expect(s.chunks).toHaveLength(sections.length);
    expect(s.reason).toBe('no-match');
    expect(s.scanned).toBe(sections.length);
    expect(s.skipped).toBe(0);
  });

  it('reports counts that add up to the total', () => {
    const s = selectChunksForQuestion(sections, 'who pays for repairs and the deposit?');
    expect(s.total).toBe(sections.length);
    expect(s.scanned + s.skipped).toBe(s.total);
    expect(s.scanned).toBe(s.chunks.length);
    expect(s.scanned).toBe(2);
    expect(s.skipped).toBe(2);
  });

  it('keeps document order', () => {
    const s = selectChunksForQuestion(sections, 'the landlord and the tenant');
    const order = s.chunks.map((c) => c.index);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('scanNote', () => {
  it('says how many sections were scanned and skipped', () => {
    const note = scanNote(selectChunksForQuestion(sections, 'what is the deposit?'));
    expect(note).toBe('Scanned 1 of 4 sections; 3 had no match for your terms (deposit).');
  });

  it('says so when nothing was skipped', () => {
    const note = scanNote(selectChunksForQuestion(sections, 'deposit repairs laws terminate'));
    expect(note).toMatch(/^Scanned all 4 sections/);
  });

  it('explains a question with no terms and a question with no matching section', () => {
    expect(scanNote(selectChunksForQuestion(sections, 'what is this?'))).toBe(
      'Your question had no specific terms, so all 4 sections were scanned.',
    );
    expect(scanNote(selectChunksForQuestion(sections, 'arbitration venue'))).toBe(
      'No section mentions your terms (arbitration, venue), so all 4 sections were scanned.',
    );
  });
});

describe('wholeChunks', () => {
  it('returns every chunk when no subset is given', () => {
    expect(wholeChunks(sections)).toBe(sections);
  });

  it('returns only the given indexes, in document order', () => {
    expect(wholeChunks(sections, [3, 0]).map((c) => c.index)).toEqual([0, 3]);
  });
});
