import { describe, it, expect } from 'vitest';
import { hasDefinitionCue, selectDefinitionChunks } from './definitions';
import type { ChunkRecord } from '../runner/db';

const chunk = (index: number, text: string): ChunkRecord =>
  ({ id: `doc:${index}`, docId: 'doc', index, text }) as ChunkRecord;

describe('definition cue with different party names', () => {
  it('finds a definitions clause without naming any role', () => {
    expect(hasDefinitionCue('"Premises" means the unit described in Schedule 1.')).toBe(true);
    expect(hasDefinitionCue('In this Deed, "Licensor" shall mean Northwind Trading LLP.')).toBe(true);
    expect(hasDefinitionCue('the party hereinafter referred to as the Operator')).toBe(true);
  });

  it('finds an opening recital that introduces two parties by name', () => {
    expect(hasDefinitionCue('This Licence is made between Northwind Trading LLP and Blue Harbour Trust.')).toBe(true);
  });

  it('does not depend on a role word such as society, developer or purchaser', () => {
    expect(hasDefinitionCue('The developer shall deliver the units.')).toBe(false);
    expect(hasDefinitionCue('The purchaser pays the price to the society.')).toBe(false);
  });

  it('selects only chunks with a cue, in order, up to the limit', () => {
    const chunks = [
      chunk(0, 'Cover page.'),
      chunk(1, 'This Agreement is between Acme Holdings and Zenith Trust.'),
      chunk(2, '"Service" means the work described here.'),
      chunk(3, 'Unrelated payment text.'),
    ];
    expect(selectDefinitionChunks(chunks).map((c) => c.index)).toEqual([1, 2]);
    expect(selectDefinitionChunks(chunks, 1).map((c) => c.index)).toEqual([1]);
  });
});
