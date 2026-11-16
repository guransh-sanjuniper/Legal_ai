import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openHarnessDb, type ChunkRecord, type HarnessDBHandle } from '../runner/db';
import { buildDocAliases } from './plan';
import { loadRefStructures, MAX_HEADINGS } from './refStructure';
import type { SourceBinding } from './types';

const DB_NAME = 'pipeline-harness';

let db: HarnessDBHandle;
let seq = 0;

function chunk(over: Partial<ChunkRecord> = {}): ChunkRecord {
  seq++;
  return {
    id: `chunk-${seq}`,
    docId: 'doc-a',
    prepFingerprint: 'p',
    index: seq,
    text: 'text',
    carried: null,
    pageStart: 1,
    pageEnd: 1,
    clauseFrom: null,
    clauseTo: null,
    clauses: [],
    startKind: 'clause',
    heading: null,
    parentSection: null,
    tokenEst: 10,
    units: 1,
    split: false,
    partIndex: null,
    partCount: null,
    sectionBreak: false,
    unusuallyLong: false,
    pageMarkedText: 'text',
    ...over,
  };
}

const docs = buildDocAliases([
  { refDocId: 'doc-a', name: 'A.pdf', pageCount: 10, available: true },
  { refDocId: 'doc-b', name: 'B.pdf', pageCount: 12, available: true },
  { refDocId: 'doc-c', name: 'C.pdf', pageCount: 20, available: true },
]);

function binding(over: Partial<SourceBinding> = {}): SourceBinding {
  return {
    id: 'bind-1',
    refDocId: 'doc-a',
    target: { type: 'whole', value: '' },
    useMode: 'verbatim',
    appliesTo: '',
    phrase: '',
    ...over,
  };
}

describe('reference structure hints', () => {
  beforeEach(async () => {
    await deleteDB(DB_NAME);
    db = await openHarnessDb();
  });

  afterEach(async () => {
    db.close();
    await deleteDB(DB_NAME);
  });

  it('reads top-level headings and ignores sub-clauses, lettered lists and preambles', async () => {
    for (const heading of ['1. Parties', '2. Term', '3. Rent', '4. Deposit']) {
      await db.put('chunks', chunk({ docId: 'doc-a', heading, startKind: 'clause' }));
    }
    await db.put('chunks', chunk({ docId: 'doc-a', heading: '2.1 Rent review', startKind: 'subclause' }));
    await db.put('chunks', chunk({ docId: 'doc-a', heading: 'a) Notices', startKind: 'lettered' }));
    await db.put('chunks', chunk({ docId: 'doc-a', heading: '', startKind: 'preamble' }));
    await db.put('chunks', chunk({ docId: 'doc-b', heading: '1. Grant', startKind: 'clause' }));
    await db.put('chunks', chunk({ docId: 'doc-b', heading: '2. Term', startKind: 'clause' }));

    const result = await loadRefStructures(db, docs, []);

    expect(result.structures).toHaveLength(1);
    expect(result.structures[0]).toMatchObject({
      refDocId: 'doc-a',
      alias: 'Doc A',
      headings: ['1. Parties', '2. Term', '3. Rent', '4. Deposit'],
    });
    expect(result.skipped).toEqual([
      { refDocId: 'doc-b', alias: 'Doc B', reason: 'no usable headings' },
      { refDocId: 'doc-c', alias: 'Doc C', reason: 'no usable headings' },
    ]);
  });

  it('reads only documents with no binding or a style binding', async () => {
    for (const heading of ['1. One', '2. Two', '3. Three']) {
      await db.put('chunks', chunk({ docId: 'doc-a', heading }));
      await db.put('chunks', chunk({ docId: 'doc-b', heading }));
    }

    const result = await loadRefStructures(db, docs, [
      binding({ id: 'b1', refDocId: 'doc-a', useMode: 'verbatim' }),
      binding({ id: 'b2', refDocId: 'doc-b', useMode: 'style' }),
    ]);

    expect(result.structures.map((structure) => structure.refDocId)).toEqual(['doc-b']);
  });

  it('caps the headings per document and their length', async () => {
    for (let index = 0; index < 70; index++) {
      await db.put(
        'chunks',
        chunk({ docId: 'doc-a', heading: `Heading ${index} ${'x'.repeat(120)}` }),
      );
    }

    const result = await loadRefStructures(db, docs, []);
    expect(result.structures[0].headings).toHaveLength(MAX_HEADINGS);
    expect(result.structures[0].headings.every((heading) => heading.length <= 90)).toBe(true);
  });

  it('reads at most five documents', async () => {
    const many = buildDocAliases(
      Array.from({ length: 6 }, (_, index) => ({
        refDocId: `doc-${index}`,
        name: `Doc ${index}.pdf`,
        pageCount: 10,
        available: true,
      })),
    );
    for (let index = 0; index < 6; index++) {
      for (const heading of ['1. A', '2. B', '3. C']) {
        await db.put('chunks', chunk({ docId: `doc-${index}`, heading }));
      }
    }

    const result = await loadRefStructures(db, many, []);
    expect(result.structures).toHaveLength(5);
  });

  it('only reads the chunks store', async () => {
    for (const heading of ['1. A', '2. B', '3. C']) {
      await db.put('chunks', chunk({ docId: 'doc-a', heading }));
    }
    const before = await db.getAll('chunks');
    await loadRefStructures(db, docs, []);
    const after = await db.getAll('chunks');
    expect(after).toEqual(before);
  });
});
