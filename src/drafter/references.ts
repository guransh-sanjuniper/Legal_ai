// Reference resolution for the Brief form. Pure functions: the UI supplies the library list
// (with the Ready flag computed by the library's own `isPrepared`), these decide what can be
// selected and how a saved reference is shown.

export interface LibraryEntry {
  id: string;
  name: string;
  pageCount: number;
  ready: boolean;
}

export type ReferenceAvailability = 'ready' | 'not-ready' | 'missing';

export interface ReferenceView {
  id: string;
  // null when the document is not on this device.
  name: string | null;
  pageCount: number | null;
  availability: ReferenceAvailability;
}

// Only a Ready document may be attached to a draft.
export function selectableReferences(library: LibraryEntry[]): LibraryEntry[] {
  return library
    .filter((doc) => doc.ready)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Saved ids keep their order and are never dropped. A reference that is no longer on this
// device is flagged, not removed; the user can remove it explicitly.
export function referenceViews(savedIds: string[], library: LibraryEntry[]): ReferenceView[] {
  const byId = new Map(library.map((doc) => [doc.id, doc]));
  const seen = new Set<string>();
  const views: ReferenceView[] = [];
  for (const id of savedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const doc = byId.get(id);
    if (!doc) {
      views.push({ id, name: null, pageCount: null, availability: 'missing' });
    } else {
      views.push({
        id,
        name: doc.name,
        pageCount: doc.pageCount,
        availability: doc.ready ? 'ready' : 'not-ready',
      });
    }
  }
  return views;
}
