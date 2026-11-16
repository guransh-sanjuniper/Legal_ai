import { openHarnessDb } from '../../runner/db';
import { isPrepared } from '../library/preparationState';
import type { LibraryEntry } from '../../drafter/references';

// The library list for the Drafter: every document on this device with the library's own Ready
// flag. Read-only use of the existing harness storage and preparation check.
export async function loadDrafterLibrary(): Promise<LibraryEntry[]> {
  const db = await openHarnessDb();
  const docs = await db.getAll('documents');
  const entries: LibraryEntry[] = [];
  for (const doc of docs) {
    entries.push({
      id: doc.id,
      name: doc.name,
      pageCount: doc.pageCount,
      ready: await isPrepared(db, doc),
    });
  }
  return entries;
}
