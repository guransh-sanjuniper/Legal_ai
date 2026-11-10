import { describe, it, expect } from 'vitest';
import { mergeDefinitions, isValidDefinitionItem, type DefinitionItem } from './definitionsMerge';

const items: DefinitionItem[] = [
  { kind: 'party', name: 'Hira Moti Nagar Co-operative Housing Society Ltd', clause: 'Recital A', page: 2 },
  { kind: 'party', name: 'M/s Mandar Constructions & Projects LLP', clause: 'Recital A', page: 2 },
  { kind: 'party', name: 'hira moti nagar co-operative housing society ltd', page: 3 },
  { kind: 'term', term: 'Said Land', definition: 'the land admeasuring 7873.81 square meters', clause: '3', page: 11 },
  { kind: 'term', term: 'said land', definition: 'duplicate with different case', clause: '3', page: 11 },
  { kind: 'term', term: 'New Premises', definition: 'the premises allotted under clause 12', clause: '12', page: 20 },
  { kind: 'date', date: '31 March 2027', description: 'possession handover', clause: '25', page: 44 },
  { kind: 'date', date: '31 March 2027', description: 'possession handover', clause: '25', page: 44 },
  { kind: 'date', date: '05 July 2026', description: 'special general meeting', page: 1 },
];

describe('definitions sheet merge', () => {
  it('deduplicates parties case-insensitively and keeps order', () => {
    const sheet = mergeDefinitions(items);
    expect(sheet.parties).toEqual([
      'Hira Moti Nagar Co-operative Housing Society Ltd',
      'M/s Mandar Constructions & Projects LLP',
    ]);
  });

  it('deduplicates terms by normalised term', () => {
    const sheet = mergeDefinitions(items);
    expect(sheet.defined_terms.map((t) => t.term)).toEqual(['Said Land', 'New Premises']);
    expect(sheet.defined_terms[0].definition).toBe('the land admeasuring 7873.81 square meters');
  });

  it('deduplicates identical dates but keeps different dates', () => {
    const sheet = mergeDefinitions(items);
    expect(sheet.key_dates.map((d) => d.date)).toEqual(['31 March 2027', '05 July 2026']);
  });

  it('records the source chunks', () => {
    const sheet = mergeDefinitions(items, [{ chunkId: 'd1:3', pageStart: 10, pageEnd: 12 }]);
    expect(sheet.sources).toEqual([{ chunkId: 'd1:3', pageStart: 10, pageEnd: 12 }]);
  });

  it('drops invalid items instead of failing the whole sheet', () => {
    const mixed = [...items, { kind: 'term', term: '', definition: 'x' } as DefinitionItem, { kind: 'nope' } as unknown as DefinitionItem];
    const sheet = mergeDefinitions(mixed);
    expect(sheet.defined_terms.length).toBe(2);
    expect(isValidDefinitionItem({ kind: 'party', name: 'A' })).toBe(true);
    expect(isValidDefinitionItem({ kind: 'party', name: '  ' })).toBe(false);
    expect(isValidDefinitionItem({ kind: 'term', term: 'T' })).toBe(false);
  });
});
