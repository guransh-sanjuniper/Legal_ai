import { FINAL_PAGE_STATUSES, type HarnessDBHandle, type OcrDecision, type PageRecord } from '../runner/db';

export type ReviewDecision = 'accept' | 'correct' | 'blank' | 'unresolved';

const pageRange = (docId: string) => IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]);

// A page the user chose to proceed without reviewing keeps its extracted text as-is.
// It is accepted for chunking like any other page, but recorded as 'waived' so it is
// never shown as human-confirmed.
export function waivedPageFields(decision: OcrDecision): Pick<PageRecord, 'text' | 'status' | 'source' | 'reason' | 'dpi'> {
  return { text: decision.text, status: 'accepted', source: 'waived', reason: null, dpi: null };
}

// Saves one human decision for a page. The caller re-runs ingestion afterwards.
export async function saveReviewDecision(
  db: HarnessDBHandle,
  page: PageRecord,
  decision: ReviewDecision,
  text?: string,
): Promise<void> {
  const now = Date.now();
  const finalText = decision === 'blank' ? '' : decision === 'correct' ? (text ?? '') : page.text;
  await db.put('ocr_decisions', { docId: page.docId, pageNo: page.pageNo, decision, text: finalText, savedAt: now }, [
    page.docId,
    page.pageNo,
  ]);
  if (decision === 'unresolved') {
    await db.put('pages', { ...page, status: 'review', reason: 'unresolved', updatedAt: now }, [page.docId, page.pageNo]);
  } else {
    await db.put(
      'pages',
      { ...page, text: finalText, status: decision === 'blank' ? 'blank' : 'accepted', source: 'manual', reason: null, updatedAt: now },
      [page.docId, page.pageNo],
    );
  }
}

// "Proceed without reviewing": every page still needing review keeps its extracted text.
// Pages with a human decision are left alone. Returns how many pages were waived.
export async function waiveUnresolvedPages(db: HarnessDBHandle, docId: string): Promise<number> {
  const tx = db.transaction(['pages', 'ocr_decisions'], 'readwrite');
  const pages = tx.objectStore('pages');
  const decisions = tx.objectStore('ocr_decisions');
  let waived = 0;
  for (const page of await pages.getAll(pageRange(docId))) {
    if (FINAL_PAGE_STATUSES.includes(page.status)) continue;
    const now = Date.now();
    const decision: OcrDecision = { docId, pageNo: page.pageNo, decision: 'waived', text: page.text, savedAt: now };
    await decisions.put(decision, [docId, page.pageNo]);
    await pages.put({ ...page, ...waivedPageFields(decision), updatedAt: now }, [docId, page.pageNo]);
    waived++;
  }
  await tx.done;
  return waived;
}

// Pages accepted without review ("waived"). Used for the library label and the report banner.
export async function countWaivedPages(db: HarnessDBHandle, docId: string): Promise<number> {
  let count = 0;
  let cursor = await db.transaction('pages').store.openCursor(pageRange(docId));
  while (cursor) {
    if (cursor.value.source === 'waived') count++;
    cursor = await cursor.continue();
  }
  return count;
}
