import type { ChunkRecord, DocumentRecord, HarnessDBHandle, PageRecord } from '../runner/db';
import { outlineFingerprint, planFingerprint } from './outline';
import { parsePageRange } from './plan';
import type {
  DraftRecord,
  SourceBinding,
  SourceCandidate,
  SourceResolution,
  SourceText,
} from './types';

// D4a: read the stored text for the sources the user bound to the outline. Read-only over the
// harness DB (`documents`, `pages`, `chunks`); nothing here writes to `pipeline-harness`.
// Keyword-only: the retrieval worker is deliberately not used.

export const MAX_SOURCE_CHARS = 12_000;
export const MAX_WHOLE_PAGES = 6;
export const MAX_TOPIC_CANDIDATES = 3;
export const MIN_TOPIC_SCORE_TWO_TERMS = 2;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'shall', 'will', 'may', 'must', 'under',
  'into', 'upon', 'such', 'other', 'than', 'then', 'there', 'their', 'them', 'they', 'have',
  'has', 'had', 'are', 'was', 'were', 'been', 'being', 'not', 'all', 'any', 'each', 'its',
  'his', 'her', 'our', 'your', 'you', 'who', 'which', 'what', 'when', 'where', 'how', 'per',
  'agreement', 'document', 'clause', 'clauses', 'section', 'party', 'parties', 'term', 'terms',
]);

export function tokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function uniqueTerms(texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const token of tokens(text)) if (!out.includes(token)) out.push(token);
  }
  return out;
}

function termMatches(term: string, textTokens: Set<string>): boolean {
  const prefix = term.slice(0, 6);
  for (const token of textTokens) {
    if (term.length < 6 ? token.startsWith(term) : token.startsWith(prefix)) return true;
  }
  return false;
}

function overlap(terms: string[], text: string): number {
  const textTokens = new Set(tokens(text));
  return terms.filter((term) => termMatches(term, textTokens)).length;
}

function capText(text: string): { text: string; chars: number; truncated?: boolean } {
  if (text.length <= MAX_SOURCE_CHARS) return { text, chars: text.length };
  return { text: text.slice(0, MAX_SOURCE_CHARS), chars: text.length, truncated: true };
}

interface DocData {
  doc: DocumentRecord;
  pages: PageRecord[];
  chunks: ChunkRecord[];
}

async function loadDocData(db: HarnessDBHandle, docId: string): Promise<DocData | null> {
  const doc = await db.get('documents', docId);
  if (!doc) return null;
  const pages = (await db.getAll('pages')).filter((page) => page.docId === docId);
  const maxPage = pages.reduce((max, page) => Math.max(max, page.pageNo), 0);
  const effective = doc.pageCount > 0 ? doc : { ...doc, pageCount: maxPage };
  const chunks = (await db.getAll('chunks'))
    .filter(
      (chunk) =>
        chunk.docId === docId &&
        (!effective.prepFingerprint || !chunk.prepFingerprint || chunk.prepFingerprint === effective.prepFingerprint),
    )
    .sort((a, b) => a.index - b.index);
  return { doc: effective, pages, chunks };
}

function pagesInRange(pages: PageRecord[], start: number, end: number): string | null {
  const inRange = pages
    .filter((page) => page.pageNo >= start && page.pageNo <= end)
    .sort((a, b) => a.pageNo - b.pageNo);
  if (inRange.length === 0) return null;
  return inRange.map((page) => `[[p${page.pageNo}]]\n${page.text}`).join('\n');
}

function pageLabel(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

function candidateFromChunks(group: ChunkRecord[], label: string, prefix: string): SourceCandidate {
  const text = group.map((chunk) => chunk.pageMarkedText || chunk.text).join('\n\n');
  const pageStart = Math.min(...group.map((chunk) => chunk.pageStart));
  const pageEnd = Math.max(...group.map((chunk) => chunk.pageEnd));
  return {
    id: `${prefix}:${group[0].index}`,
    label,
    pages: pageLabel(pageStart, pageEnd),
    ...capText(text),
  };
}

function candidateFromPages(pages: PageRecord[], start: number, end: number): SourceCandidate | null {
  const text = pagesInRange(pages, start, end);
  if (!text) return null;
  return {
    id: `pages:${start}-${end}`,
    label: `Pages ${pageLabel(start, end)}`,
    pages: pageLabel(start, end),
    ...capText(text),
  };
}

function groupContiguous(chunks: ChunkRecord[]): ChunkRecord[][] {
  const groups: ChunkRecord[][] = [];
  for (const chunk of chunks) {
    const last = groups[groups.length - 1];
    if (last && chunk.index === last[last.length - 1].index + 1) last.push(chunk);
    else groups.push([chunk]);
  }
  return groups;
}

export function normaliseClauseValue(value: string): string {
  return value
    .trim()
    .replace(/^(clause|section)\s+/i, '')
    .replace(/[.;:,]+$/, '')
    .trim();
}

function chunkHasLabel(chunk: ChunkRecord, label: string): boolean {
  return chunk.clauses.includes(label) || chunk.clauseFrom === label || chunk.clauseTo === label;
}

function resolveClause(binding: SourceBinding, data: DocData): SourceResolution {
  const value = normaliseClauseValue(binding.target.value);
  const numeric = /^\d+(?:\.\d+)*$/.test(value);
  if (!value) {
    return {
      bindingId: binding.id,
      status: 'not_found',
      candidates: [],
      userConfirmed: false,
      note: 'No clause was given for this source.',
    };
  }

  const matched = numeric
    ? data.chunks.filter((chunk) => chunkHasLabel(chunk, value))
    : data.chunks.filter((chunk) => chunk.heading && chunk.heading.toLowerCase().includes(value.toLowerCase()));

  if (matched.length === 0) {
    return {
      bindingId: binding.id,
      status: 'not_found',
      candidates: [],
      userConfirmed: false,
      note: `I could not find "${value}" in ${data.doc.name}.`,
    };
  }

  const groups = groupContiguous(matched);
  const candidates = groups.map((group) =>
    candidateFromChunks(
      group,
      numeric ? `Clause ${value}` : (group[0].heading ?? value),
      `clause:${value}`,
    ),
  );

  if (groups.length > 1) {
    return {
      bindingId: binding.id,
      status: 'ambiguous',
      candidates,
      userConfirmed: false,
      note: 'This label appears more than once in the document.',
    };
  }

  const applies = uniqueTerms([binding.appliesTo]);
  if (numeric && applies.length > 0 && overlap(applies, candidates[0].text) === 0) {
    return {
      bindingId: binding.id,
      status: 'ambiguous',
      candidates,
      userConfirmed: false,
      note: 'The text of this clause does not look like it covers the use you described.',
    };
  }

  return {
    bindingId: binding.id,
    status: 'resolved',
    candidates,
    chosenCandidateId: candidates[0].id,
    userConfirmed: false,
  };
}

function resolveTopic(binding: SourceBinding, data: DocData): SourceResolution {
  const terms = uniqueTerms([binding.target.value, binding.appliesTo]);
  if (terms.length === 0) {
    return {
      bindingId: binding.id,
      status: 'not_found',
      candidates: [],
      userConfirmed: false,
      note: 'No topic words were given for this source.',
    };
  }

  const scored = data.chunks
    .map((chunk) => {
      const set = new Set(tokens(chunk.text));
      return { chunk, score: terms.filter((term) => termMatches(term, set)).length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index)
    .slice(0, MAX_TOPIC_CANDIDATES);

  const minimum = terms.length >= 2 ? MIN_TOPIC_SCORE_TWO_TERMS : 1;
  if (scored.length === 0 || scored[0].score < minimum) {
    return {
      bindingId: binding.id,
      status: 'not_found',
      candidates: [],
      userConfirmed: false,
      note: `I could not find a part of ${data.doc.name} about "${binding.target.value}".`,
    };
  }

  const candidates = scored.map(({ chunk, score }) => ({
    id: `topic:${chunk.id}`,
    label:
      chunk.heading ||
      (chunk.clauseFrom ? `Clause ${chunk.clauseFrom}` : `Pages ${pageLabel(chunk.pageStart, chunk.pageEnd)}`),
    pages: pageLabel(chunk.pageStart, chunk.pageEnd),
    ...capText(chunk.pageMarkedText || chunk.text),
    score,
  }));

  return { bindingId: binding.id, status: 'ambiguous', candidates, userConfirmed: false };
}

function resolveBindingWithData(binding: SourceBinding, data: DocData): SourceResolution {
  switch (binding.target.type) {
    case 'pages': {
      const range = parsePageRange(binding.target.value, data.doc.pageCount);
      if (!range) {
        return {
          bindingId: binding.id,
          status: 'not_found',
          candidates: [],
          userConfirmed: false,
          note: `Pages "${binding.target.value}" are outside ${data.doc.name} (${data.doc.pageCount} pages).`,
        };
      }
      const candidate = candidateFromPages(data.pages, range.start, range.end);
      if (!candidate) {
        return {
          bindingId: binding.id,
          status: 'not_found',
          candidates: [],
          userConfirmed: false,
          note: `Pages ${binding.target.value} are not stored on this device.`,
        };
      }
      return {
        bindingId: binding.id,
        status: 'resolved',
        candidates: [candidate],
        chosenCandidateId: candidate.id,
        userConfirmed: false,
      };
    }
    case 'clause':
      return resolveClause(binding, data);
    case 'topic':
      return resolveTopic(binding, data);
    case 'whole': {
      if (data.doc.pageCount > 0 && data.doc.pageCount <= MAX_WHOLE_PAGES) {
        const candidate = candidateFromPages(data.pages, 1, data.doc.pageCount);
        if (candidate) {
          return {
            bindingId: binding.id,
            status: 'resolved',
            candidates: [{ ...candidate, id: `whole:${data.doc.id}`, label: 'Whole document' }],
            chosenCandidateId: `whole:${data.doc.id}`,
            userConfirmed: false,
          };
        }
      }
      return {
        bindingId: binding.id,
        status: 'too_broad',
        candidates: [],
        userConfirmed: false,
        note: `${data.doc.name} is too long to use whole. Pick the pages you need.`,
      };
    }
  }
}

// Resolves every verbatim/adapt binding. Style bindings are not read: their heading hints were
// used when the outline was made.
export async function resolveAll(db: HarnessDBHandle, draft: DraftRecord): Promise<SourceText> {
  const bindings = (draft.sourcePlan?.bindings ?? []).filter(
    (binding) => binding.useMode === 'verbatim' || binding.useMode === 'adapt',
  );
  const cache = new Map<string, DocData | null>();
  const resolutions: SourceResolution[] = [];

  for (const binding of bindings) {
    if (!cache.has(binding.refDocId)) cache.set(binding.refDocId, await loadDocData(db, binding.refDocId));
    const data = cache.get(binding.refDocId) ?? null;
    if (!data) {
      resolutions.push({
        bindingId: binding.id,
        status: 'not_found',
        candidates: [],
        userConfirmed: false,
        note: 'This document is not on this device.',
      });
      continue;
    }
    resolutions.push(resolveBindingWithData(binding, data));
  }

  return {
    resolutions,
    resolvedAt: new Date().toISOString(),
    planFingerprint: planFingerprint(draft),
    outlineFingerprint: outlineFingerprint(draft.outline),
  };
}

// Used by the Sources screen's "Pick pages instead".
export async function resolvePageRange(
  db: HarnessDBHandle,
  binding: SourceBinding,
  start: number,
  end: number,
): Promise<SourceResolution> {
  const data = await loadDocData(db, binding.refDocId);
  if (!data) {
    return {
      bindingId: binding.id,
      status: 'not_found',
      candidates: [],
      userConfirmed: false,
      note: 'This document is not on this device.',
    };
  }
  if (!(start >= 1 && end >= start && end <= data.doc.pageCount)) {
    return {
      bindingId: binding.id,
      status: 'not_found',
      candidates: [],
      userConfirmed: false,
      note: `Pick a page range inside ${data.doc.name} (1-${data.doc.pageCount}).`,
    };
  }
  const candidate = candidateFromPages(data.pages, start, end);
  if (!candidate) {
    return {
      bindingId: binding.id,
      status: 'not_found',
      candidates: [],
      userConfirmed: false,
      note: 'Those pages are not stored on this device.',
    };
  }
  return {
    bindingId: binding.id,
    status: 'resolved',
    candidates: [candidate],
    chosenCandidateId: candidate.id,
    userConfirmed: false,
  };
}

export function chosenCandidate(resolution: SourceResolution): SourceCandidate | null {
  if (!resolution.chosenCandidateId) return null;
  return resolution.candidates.find((candidate) => candidate.id === resolution.chosenCandidateId) ?? null;
}

// A source may only be used once the user confirmed it on the Sources screen.
export function usableSource(sourceText: SourceText | null, bindingId: string): SourceCandidate | null {
  const resolution = sourceText?.resolutions.find((entry) => entry.bindingId === bindingId);
  if (!resolution || resolution.skipped || !resolution.userConfirmed) return null;
  return chosenCandidate(resolution);
}

export function sourceTextStale(sourceText: SourceText | null, draft: DraftRecord): boolean {
  if (!sourceText) return false;
  if (sourceText.planFingerprint !== planFingerprint(draft)) return true;
  return sourceText.outlineFingerprint !== outlineFingerprint(draft.outline);
}

// Every verbatim/adapt binding must be confirmed or skipped, and the text must be present on
// this device, before writing can start.
export function sourceTextReady(sourceText: SourceText | null, draft: DraftRecord): boolean {
  if (!sourceText) return false;
  if (sourceTextStale(sourceText, draft)) return false;
  const bindings = (draft.sourcePlan?.bindings ?? []).filter(
    (binding) => binding.useMode === 'verbatim' || binding.useMode === 'adapt',
  );
  return bindings.every((binding) => {
    const resolution = sourceText.resolutions.find((entry) => entry.bindingId === binding.id);
    if (!resolution) return false;
    if (resolution.skipped) return true;
    return resolution.userConfirmed && Boolean(chosenCandidate(resolution)?.text);
  });
}

// Supabase keeps only the resolution metadata: source text stays on the device.
export function sourceTextForSync(sourceText: SourceText | null): SourceText | null {
  if (!sourceText) return null;
  return {
    ...sourceText,
    resolutions: sourceText.resolutions.map((resolution) => ({
      ...resolution,
      candidates: resolution.candidates.map((candidate) => ({ ...candidate, text: '' })),
    })),
  };
}

export function normaliseStoredSourceText(value: unknown): SourceText | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stored = value as Partial<SourceText>;
  if (!Array.isArray(stored.resolutions)) return null;
  if (typeof stored.planFingerprint !== 'string' || typeof stored.outlineFingerprint !== 'string') return null;
  return {
    resolutions: stored.resolutions.map((resolution) => ({
      ...resolution,
      candidates: (Array.isArray(resolution.candidates) ? resolution.candidates : []).map((candidate) => ({
        ...candidate,
        text: typeof candidate.text === 'string' ? candidate.text : '',
      })),
    })),
    resolvedAt: typeof stored.resolvedAt === 'string' ? stored.resolvedAt : '',
    planFingerprint: stored.planFingerprint,
    outlineFingerprint: stored.outlineFingerprint,
  } as SourceText;
}
