import type { HarnessDBHandle } from '../runner/db';
import type { DocAlias } from './plan';
import type { SourceBinding } from './types';

// Read-only reference structure hints for D3. For a document used as a general or style
// reference, we send a compact list of its top-level headings so the model can follow the
// shape. The text of a bound source (verbatim/adapt) is never read here.

export const MAX_STRUCTURE_DOCS = 5;
export const MAX_HEADINGS = 60;
export const MAX_HEADING_CHARS = 90;
export const MIN_HEADINGS = 3;

// The chunker stores the heading line on chunks that start a clause, section or part.
const STRUCTURE_START_KINDS = new Set(['clause', 'section', 'part']);

export interface RefStructure {
  refDocId: string;
  alias: string;
  headings: string[];
}

export interface RefStructureSkip {
  refDocId: string;
  alias: string;
  reason: string;
}

export interface RefStructureResult {
  structures: RefStructure[];
  skipped: RefStructureSkip[];
}

// A document is a structure hint only when the user has no binding for it, or only style
// bindings.
export function wantsStructure(bindings: SourceBinding[], refDocId: string): boolean {
  const own = bindings.filter((binding) => binding.refDocId === refDocId);
  return own.length === 0 || own.every((binding) => binding.useMode === 'style');
}

export async function loadRefStructures(
  db: HarnessDBHandle,
  docs: DocAlias[],
  bindings: SourceBinding[],
): Promise<RefStructureResult> {
  const targets = docs
    .filter((doc) => doc.available && wantsStructure(bindings, doc.refDocId))
    .slice(0, MAX_STRUCTURE_DOCS);
  if (targets.length === 0) return { structures: [], skipped: [] };

  const wanted = new Map(targets.map((doc) => [doc.refDocId, doc]));
  const collected = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  for (const doc of targets) {
    collected.set(doc.refDocId, []);
    seen.set(doc.refDocId, new Set());
  }

  // Read-only cursor over the stored chunks. No store is opened for writing.
  const tx = db.transaction('chunks');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    const chunk = cursor.value;
    if (wanted.has(chunk.docId) && STRUCTURE_START_KINDS.has(chunk.startKind) && chunk.heading) {
      const list = collected.get(chunk.docId);
      const known = seen.get(chunk.docId);
      if (list && known) {
        const heading = chunk.heading.trim().slice(0, MAX_HEADING_CHARS).trim();
        if (heading && !known.has(heading) && list.length < MAX_HEADINGS) {
          known.add(heading);
          list.push(heading);
        }
      }
    }
    if ([...collected.values()].every((list) => list.length >= MAX_HEADINGS)) break;
    cursor = await cursor.continue();
  }
  await tx.done;

  const structures: RefStructure[] = [];
  const skipped: RefStructureSkip[] = [];
  for (const doc of targets) {
    const headings = collected.get(doc.refDocId) ?? [];
    if (headings.length < MIN_HEADINGS) {
      skipped.push({ refDocId: doc.refDocId, alias: doc.alias, reason: 'no usable headings' });
    } else {
      structures.push({ refDocId: doc.refDocId, alias: doc.alias, headings });
    }
  }
  return { structures, skipped };
}
