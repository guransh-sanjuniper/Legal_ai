import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openHarnessDb, type PageRecord } from '../runner/db';
import { countWaivedPages, saveReviewDecision, waiveUnresolvedPages, waivedPageFields } from './review';

const page = (docId: string, pageNo: number, overrides: Partial<PageRecord> = {}): PageRecord => ({
  docId,
  pageNo,
  text: `text ${pageNo}`,
  status: 'review',
  source: 'ocr',
  reason: 'no_text',
  dpi: 300,
  nativeChars: 0,
  imageCount: 1,
  updatedAt: 1,
  ...overrides,
});

describe('waived decision', () => {
  it('records the extracted text as accepted but waived', () => {
    expect(
      waivedPageFields({ docId: 'd', pageNo: 1, decision: 'waived', text: 'OCR words', savedAt: 1 }),
    ).toEqual({ text: 'OCR words', status: 'accepted', source: 'waived', reason: null, dpi: null });
  });

  it('keeps an empty page empty', () => {
    expect(waivedPageFields({ docId: 'd', pageNo: 1, decision: 'waived', text: '', savedAt: 1 }).text).toBe('');
  });

  it('waives only pages still needing review and keeps human decisions', async () => {
    const db = await openHarnessDb();
    const docId = 'waive-doc';
    await db.put('pages', page(docId, 1), [docId, 1]);
    await db.put('pages', page(docId, 2, { text: '' }), [docId, 2]);
    await db.put('pages', page(docId, 3, { status: 'accepted', source: 'manual', reason: null, text: 'kept' }), [docId, 3]);
    await db.put('pages', page(docId, 4, { status: 'blank', source: 'manual', reason: null, text: '' }), [docId, 4]);

    expect(await waiveUnresolvedPages(db, docId)).toBe(2);

    const p1 = await db.get('pages', [docId, 1]);
    expect(p1).toMatchObject({ status: 'accepted', source: 'waived', text: 'text 1', reason: null });
    const p2 = await db.get('pages', [docId, 2]);
    expect(p2).toMatchObject({ status: 'accepted', source: 'waived', text: '' });
    expect(await db.get('pages', [docId, 3])).toMatchObject({ status: 'accepted', source: 'manual', text: 'kept' });
    expect(await db.get('pages', [docId, 4])).toMatchObject({ status: 'blank', source: 'manual' });

    expect(await db.get('ocr_decisions', [docId, 1])).toMatchObject({ decision: 'waived', text: 'text 1' });
    expect(await db.get('ocr_decisions', [docId, 3])).toBeUndefined();
    expect(await countWaivedPages(db, docId)).toBe(2);
  });

  it('is idempotent: a second waiver finds nothing to waive', async () => {
    const db = await openHarnessDb();
    const docId = 'waive-twice';
    await db.put('pages', page(docId, 1), [docId, 1]);
    expect(await waiveUnresolvedPages(db, docId)).toBe(1);
    expect(await waiveUnresolvedPages(db, docId)).toBe(0);
    expect(await countWaivedPages(db, docId)).toBe(1);
  });

  it('an unresolved decision stays in review', async () => {
    const db = await openHarnessDb();
    const docId = 'unresolved-doc';
    const target = page(docId, 1);
    await db.put('pages', target, [docId, 1]);
    await saveReviewDecision(db, target, 'unresolved');
    expect(await db.get('pages', [docId, 1])).toMatchObject({ status: 'review', reason: 'unresolved' });
    expect(await countWaivedPages(db, docId)).toBe(0);
  });

  it('a human correction replaces a waived page and removes it from the waived count', async () => {
    const db = await openHarnessDb();
    const docId = 'correct-after-waive';
    await db.put('pages', page(docId, 1), [docId, 1]);
    await waiveUnresolvedPages(db, docId);
    const waived = await db.get('pages', [docId, 1]);
    expect(waived).toBeDefined();
    await saveReviewDecision(db, waived!, 'correct', 'fixed text');
    expect(await db.get('pages', [docId, 1])).toMatchObject({ status: 'accepted', source: 'manual', text: 'fixed text' });
    expect(await countWaivedPages(db, docId)).toBe(0);
  });
});
