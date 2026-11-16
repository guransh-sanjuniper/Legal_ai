import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openHarnessDb, type ChunkRecord, type DocumentRecord, type HarnessDBHandle, type PageRecord } from '../runner/db';
import {
  normaliseStoredSourceText,
  resolveAll,
  resolvePageRange,
  sourceTextForSync,
  sourceTextReady,
  sourceTextStale,
  usableSource,
} from './resolveRef';
import type { DraftRecord, Outline, SourceBinding, SourcePlan } from './types';

const DB_NAME = 'pipeline-harness';

let db: HarnessDBHandle;
let seq = 0;

function doc(over: Partial<DocumentRecord>): DocumentRecord {
  return {
    id: 'doc-a',
    name: 'A.pdf',
    hash: 'hash-a',
    size: 1,
    createdAt: 0,
    status: 'ready',
    ocrLangs: 'eng',
    pageCount: 10,
    prepFingerprint: 'p-a',
    chunkCount: 0,
    ...over,
  };
}

function page(docId: string, pageNo: number, text: string): PageRecord {
  return {
    docId,
    pageNo,
    text,
    status: 'native',
    source: 'native',
    reason: null,
    dpi: null,
    nativeChars: text.length,
    imageCount: 0,
    updatedAt: 0,
  };
}

function chunk(over: Partial<ChunkRecord> = {}): ChunkRecord {
  seq++;
  return {
    id: `chunk-${seq}`,
    docId: 'doc-a',
    prepFingerprint: 'p-a',
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
    pageMarkedText: '',
    ...over,
  };
}

function binding(over: Partial<SourceBinding> = {}): SourceBinding {
  return {
    id: 'bind-1',
    refDocId: 'doc-a',
    target: { type: 'clause', value: '14' },
    useMode: 'adapt',
    appliesTo: 'indemnity',
    phrase: 'indemnity from Doc A',
    ...over,
  };
}

const outline: Outline = {
  items: [
    {
      id: 'item-1',
      level: 1,
      title: 'Indemnity',
      purpose: 'Who covers claims',
      kind: 'clause',
      bindingIds: ['bind-1'],
    },
  ],
  notes: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  model: 'm',
  planFingerprint: 'fp',
};

function draftWith(bindings: SourceBinding[], outlineValue: Outline | null = outline): DraftRecord {
  const plan: SourcePlan = {
    docType: 'lease',
    summary: 'A lease.',
    lengthHint: null,
    referenceMode: 'specific',
    bindings,
    unresolved: [],
    questions: [],
    parsedAt: '2026-01-01T00:00:00.000Z',
    model: 'plan-model',
    parsedFrom: { instruction: 'Draft a lease.', referenceDocIds: ['doc-a'] },
  };
  return {
    id: 'draft-1',
    userId: 'user-a',
    title: 'Lease',
    instruction: 'Draft a lease.',
    referenceDocIds: ['doc-a'],
    reviewingFor: 'neutral',
    status: 'outlined',
    particulars: null,
    sourcePlan: plan,
    outline: outlineValue,
    sourceText: null,
    clauses: {},
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function seed(): Promise<void> {
  await db.put('documents', doc({ id: 'doc-a', pageCount: 10, prepFingerprint: 'p-a' }));
  await db.put('documents', doc({ id: 'doc-b', name: 'B.pdf', hash: 'hash-b', pageCount: 3, prepFingerprint: 'p-b' }));
  await db.put('documents', doc({ id: 'doc-big', name: 'Big.pdf', hash: 'hash-big', pageCount: 20, prepFingerprint: 'p-big' }));

  for (let pageNo = 1; pageNo <= 10; pageNo++) {
    const record = page('doc-a', pageNo, `Page ${pageNo} text about the premises and the parties.`);
    await db.put('pages', record, [record.docId, record.pageNo]);
  }
  for (let pageNo = 1; pageNo <= 3; pageNo++) {
    const record = page('doc-b', pageNo, `Small document page ${pageNo}.`);
    await db.put('pages', record, [record.docId, record.pageNo]);
  }

  await db.put(
    'chunks',
    chunk({
      docId: 'doc-a',
      index: 0,
      clauses: ['1'],
      clauseFrom: '1',
      clauseTo: '1',
      heading: '1. PARTIES',
      pageStart: 1,
      pageEnd: 1,
      text: 'This agreement is between the licensor and the licensee.',
      pageMarkedText: '[[p1]]\nThis agreement is between the licensor and the licensee.',
    }),
  );
  await db.put(
    'chunks',
    chunk({
      docId: 'doc-a',
      index: 1,
      clauses: ['14'],
      clauseFrom: '14',
      clauseTo: '14',
      heading: '14. INDEMNITY',
      pageStart: 5,
      pageEnd: 5,
      text: 'The licensee shall indemnify and hold harmless the licensor against all claims.',
      pageMarkedText: '[[p5]]\nThe licensee shall indemnify and hold harmless the licensor against all claims.',
    }),
  );
  await db.put(
    'chunks',
    chunk({
      docId: 'doc-a',
      index: 2,
      clauses: ['2'],
      clauseFrom: '2',
      clauseTo: '2',
      heading: '2. PAYMENT',
      pageStart: 2,
      pageEnd: 2,
      text: 'The licensee shall pay rent of Rs 50,000 on the first day of each month.',
      pageMarkedText: '[[p2]]\nThe licensee shall pay rent of Rs 50,000 on the first day of each month.',
    }),
  );
  await db.put(
    'chunks',
    chunk({
      docId: 'doc-a',
      index: 3,
      clauses: ['1'],
      clauseFrom: '1',
      clauseTo: '1',
      heading: '1. PARTIES',
      pageStart: 8,
      pageEnd: 8,
      text: 'A second section numbered one.',
      pageMarkedText: '[[p8]]\nA second section numbered one.',
    }),
  );
  await db.put(
    'chunks',
    chunk({
      docId: 'doc-a',
      index: 4,
      clauses: [],
      heading: 'INDEMNITY AND CLAIMS',
      pageStart: 6,
      pageEnd: 6,
      text: 'Indemnity claims must be notified in writing.',
      pageMarkedText: '[[p6]]\nIndemnity claims must be notified in writing.',
    }),
  );
}

describe('reference resolver', () => {
  beforeEach(async () => {
    await deleteDB(DB_NAME);
    db = await openHarnessDb();
    await seed();
  });

  afterEach(async () => {
    db.close();
    await deleteDB(DB_NAME);
  });

  it('resolves a page range', async () => {
    const result = await resolveAll(db, draftWith([binding({ target: { type: 'pages', value: '2-3' } })]));
    const resolution = result.resolutions[0];
    expect(resolution.status).toBe('resolved');
    expect(resolution.chosenCandidateId).toBeTruthy();
    expect(resolution.candidates[0].pages).toBe('2-3');
    expect(resolution.candidates[0].text).toContain('[[p2]]');
    expect(resolution.candidates[0].text).toContain('[[p3]]');
  });

  it('flags a page range outside the document', async () => {
    const result = await resolveAll(db, draftWith([binding({ target: { type: 'pages', value: '20-25' } })]));
    expect(result.resolutions[0].status).toBe('not_found');
    expect(result.resolutions[0].candidates).toEqual([]);
  });

  it('resolves a clause label when the text fits the stated use', async () => {
    const result = await resolveAll(db, draftWith([binding()]));
    const resolution = result.resolutions[0];
    expect(resolution.status).toBe('resolved');
    expect(resolution.candidates[0].text).toContain('indemnify');
  });

  it('flags a clause label when the text does not fit the stated use', async () => {
    const result = await resolveAll(
      db,
      draftWith([binding({ appliesTo: 'payment terms' })]),
    );
    expect(result.resolutions[0].status).toBe('ambiguous');
    expect(result.resolutions[0].candidates).toHaveLength(1);
  });

  it('flags a label that appears more than once instead of picking one', async () => {
    const result = await resolveAll(
      db,
      draftWith([binding({ target: { type: 'clause', value: '1' }, appliesTo: '' })]),
    );
    const resolution = result.resolutions[0];
    expect(resolution.status).toBe('ambiguous');
    expect(resolution.candidates).toHaveLength(2);
    expect(resolution.chosenCandidateId).toBeUndefined();
  });

  it('matches a non-numeric clause by its heading', async () => {
    const result = await resolveAll(
      db,
      draftWith([binding({ target: { type: 'clause', value: 'payment' }, appliesTo: 'rent' })]),
    );
    expect(result.resolutions[0].status).toBe('resolved');
    expect(result.resolutions[0].candidates[0].text).toContain('pay rent');
  });

  it('returns topic candidates and refuses a weak match', async () => {
    const strong = await resolveAll(
      db,
      draftWith([binding({ target: { type: 'topic', value: 'indemnity' }, appliesTo: 'claims' })]),
    );
    expect(strong.resolutions[0].status).toBe('ambiguous');
    expect(strong.resolutions[0].candidates.length).toBeGreaterThan(0);
    expect(strong.resolutions[0].candidates.length).toBeLessThanOrEqual(3);
    expect(strong.resolutions[0].chosenCandidateId).toBeUndefined();

    const weak = await resolveAll(
      db,
      draftWith([binding({ target: { type: 'topic', value: 'indemnity deposit' }, appliesTo: '' })]),
    );
    expect(weak.resolutions[0].status).toBe('not_found');
  });

  it('uses a whole document only when it is small', async () => {
    const small = await resolveAll(
      db,
      draftWith([binding({ refDocId: 'doc-b', target: { type: 'whole', value: '' }, appliesTo: '' })]),
    );
    expect(small.resolutions[0].status).toBe('resolved');
    expect(small.resolutions[0].candidates[0].text).toContain('[[p1]]');

    const big = await resolveAll(
      db,
      draftWith([binding({ refDocId: 'doc-big', target: { type: 'whole', value: '' }, appliesTo: '' })]),
    );
    expect(big.resolutions[0].status).toBe('too_broad');
  });

  it('flags truncated source text', async () => {
    await db.put(
      'chunks',
      chunk({
        docId: 'doc-a',
        index: 20,
        clauses: ['99'],
        clauseFrom: '99',
        clauseTo: '99',
        heading: '99. LONG',
        pageStart: 9,
        pageEnd: 9,
        text: 'x'.repeat(13_000),
      }),
    );
    const result = await resolveAll(db, draftWith([binding({ target: { type: 'clause', value: '99' }, appliesTo: '' })]));
    const candidate = result.resolutions[0].candidates[0];
    expect(candidate.truncated).toBe(true);
    expect(candidate.chars).toBe(13_000);
    expect(candidate.text).toHaveLength(12_000);
  });

  it('does not change the harness stores', async () => {
    const before = {
      documents: await db.getAll('documents'),
      pages: await db.getAll('pages'),
      chunks: await db.getAll('chunks'),
    };
    await resolveAll(db, draftWith([binding(), binding({ id: 'bind-2', target: { type: 'topic', value: 'indemnity' } })]));
    expect(await db.getAll('documents')).toEqual(before.documents);
    expect(await db.getAll('pages')).toEqual(before.pages);
    expect(await db.getAll('chunks')).toEqual(before.chunks);
  });

  it('reads a page range picked by the user', async () => {
    const result = await resolvePageRange(db, binding({ id: 'bind-1' }), 2, 2);
    expect(result.status).toBe('resolved');
    expect(result.candidates[0].pages).toBe('2');
    expect(result.userConfirmed).toBe(false);
    expect((await resolvePageRange(db, binding({ id: 'bind-1' }), 11, 12)).status).toBe('not_found');
  });

  it('keeps source text local and syncs only metadata', async () => {
    const result = await resolveAll(db, draftWith([binding()]));
    const synced = sourceTextForSync(result);
    expect(synced?.resolutions[0].candidates[0].text).toBe('');
    expect(synced?.resolutions[0].candidates[0].pages).toBe('5');

    const restored = normaliseStoredSourceText(synced);
    expect(restored?.resolutions[0].status).toBe('resolved');
    expect(restored?.resolutions[0].candidates[0].text).toBe('');
    expect(normaliseStoredSourceText({ nope: true })).toBeNull();
  });

  it('never uses a source the user has not confirmed', async () => {
    const result = await resolveAll(db, draftWith([binding()]));
    expect(usableSource(result, 'bind-1')).toBeNull();

    result.resolutions[0].userConfirmed = true;
    expect(usableSource(result, 'bind-1')?.text).toContain('indemnify');

    result.resolutions[0].skipped = true;
    expect(usableSource(result, 'bind-1')).toBeNull();
  });

  it('requires every source to be confirmed or skipped before writing', async () => {
    const draft = draftWith([binding()]);
    const result = await resolveAll(db, draft);
    expect(sourceTextReady(result, draft)).toBe(false);

    result.resolutions[0].userConfirmed = true;
    expect(sourceTextReady(result, draft)).toBe(true);

    result.resolutions[0].userConfirmed = false;
    result.resolutions[0].skipped = true;
    expect(sourceTextReady(result, draft)).toBe(true);
  });

  it('detects stale sources after the outline changes', async () => {
    const draft = draftWith([binding()]);
    const result = await resolveAll(db, draft);
    expect(sourceTextStale(result, draft)).toBe(false);

    const changed = { ...outline, items: [{ ...outline.items[0], title: 'Changed' }] };
    expect(sourceTextStale(result, draftWith([binding()], changed))).toBe(true);
  });
});
