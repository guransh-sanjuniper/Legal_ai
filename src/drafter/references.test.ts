import { describe, expect, it } from 'vitest';
import { referenceViews, selectableReferences, type LibraryEntry } from './references';

const library: LibraryEntry[] = [
  { id: 'doc-b', name: 'Bandra shop lease.pdf', pageCount: 12, ready: true },
  { id: 'doc-a', name: 'Andheri flat agreement.pdf', pageCount: 8, ready: true },
  { id: 'doc-c', name: 'Unfinished scan.pdf', pageCount: 40, ready: false },
];

describe('reference picker logic', () => {
  it('offers only documents that finished preparation, by name', () => {
    expect(selectableReferences(library).map((doc) => doc.id)).toEqual(['doc-a', 'doc-b']);
  });

  it('keeps a saved reference that is no longer on this device', () => {
    const views = referenceViews(['doc-gone', 'doc-a'], library);
    expect(views).toEqual([
      { id: 'doc-gone', name: null, pageCount: null, availability: 'missing' },
      { id: 'doc-a', name: 'Andheri flat agreement.pdf', pageCount: 8, availability: 'ready' },
    ]);
  });

  it('flags a saved reference that is present but not prepared instead of dropping it', () => {
    const views = referenceViews(['doc-c'], library);
    expect(views).toEqual([
      { id: 'doc-c', name: 'Unfinished scan.pdf', pageCount: 40, availability: 'not-ready' },
    ]);
  });

  it('preserves the saved order and ignores duplicates', () => {
    const views = referenceViews(['doc-b', 'doc-a', 'doc-b'], library);
    expect(views.map((view) => view.id)).toEqual(['doc-b', 'doc-a']);
  });

  it('returns nothing for a draft with no references', () => {
    expect(referenceViews([], library)).toEqual([]);
  });
});
