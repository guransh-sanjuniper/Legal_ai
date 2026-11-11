import { normalizeQuote } from './verify';
import { buildUnits } from '../ingest/chunk';

export interface AnchorSegment {
  page: number;
  clause: string;
  top: string | null;
  text: string;
  norm: string;
}

export interface AnchorIndex {
  pages: Map<number, string>;
  segments: AnchorSegment[];
  byPage: Map<number, AnchorSegment[]>;
}

// Real PDFs sometimes run the text straight after the bracket ("hh)The ..."), so the space is optional.
const SUB_ITEM = /^\s*\(?([a-zA-Z]{1,4}|\d{1,3})\)\s*\S/;
const RECITAL = /^\s*([A-Z])\.\s+\S/;

// Sequence value of a sub-item label. Single letters are a=1..z=26; a repeated multi-letter label
// (aa, bb, ... hh) continues that run after z. Other multi-letter labels use bijective base 26.
export function subItemOrdinal(label: string): number | null {
  const l = label.trim().toLowerCase();
  if (!l) return null;
  if (/^\d+$/.test(l)) return Number(l);
  for (const ch of l) if (ch < 'a' || ch > 'z') return null;
  if (l.length === 1) return l.charCodeAt(0) - 96;
  if (/^(.)\1$/.test(l)) return 26 + (l.charCodeAt(0) - 96);
  let n = 0;
  for (const ch of l) n = n * 26 + (ch.charCodeAt(0) - 96);
  return n;
}

// A label continues the run when it is the first label or the next value after the previous one.
export function continuesSubSequence(last: number | null, label: string): boolean {
  const ord = subItemOrdinal(label);
  if (ord === null) return false;
  return ord === 1 || (last !== null && ord === last + 1);
}

interface FlatLine {
  page: number;
  text: string;
}

// Anchors come from the same table-aware unit detection used for chunking, so table rows
// never become clause labels. Sub-items inside a unit get a composed label, such as parent plus (a).
export function buildAnchorIndex(pages: Map<number, string>): AnchorIndex {
  const pageNos = [...pages.keys()].sort((a, b) => a - b);
  const flat: FlatLine[] = [];
  for (const pageNo of pageNos) {
    for (const raw of (pages.get(pageNo) ?? '').split('\n')) {
      const text = raw.trimEnd();
      if (!text.trim()) continue;
      flat.push({ page: pageNo, text });
    }
  }

  const units = buildUnits(pageNos.map((pageNo) => ({ pageNo, text: pages.get(pageNo) ?? '' })));
  const segments: AnchorSegment[] = [];
  const byPage = new Map<number, AnchorSegment[]>();
  let pointer = 0;

  // A unit with no clause number of its own (a lettered or table unit) belongs to the clause before it,
  // so its sub-items keep that clause as their prefix. A section heading ends the clause.
  let currentTop: string | null = null;
  // Sequence value of the last accepted sub-item, per clause. Reset when the clause changes.
  let lastSub: number | null = null;
  for (const unit of units) {
    const lines = unit.text.split('\n');
    if (unit.startKind === 'section') currentTop = null;
    const top: string | null = unit.clauseNo ?? currentTop;
    if (top !== currentTop) lastSub = null;
    if (unit.startKind === 'clause' && unit.clauseNo !== null) currentTop = unit.clauseNo;
    let label = top ?? (unit.startKind === 'lettered' ? unit.heading?.slice(0, 12) ?? 'preamble' : 'preamble');
    let page = flat[pointer]?.page ?? pageNos[0];
    let text = '';

    const flush = () => {
      if (!text.trim()) return;
      const seg: AnchorSegment = { page, clause: label, top, text, norm: normalizeQuote(text) };
      segments.push(seg);
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page)!.push(seg);
      text = '';
    };

    for (const line of lines) {
      const flatLine = flat[pointer];
      if (!flatLine) break;
      pointer++;
      if (flatLine.page !== page) {
        flush();
        page = flatLine.page;
      }
      if (top !== null) {
        const sub = SUB_ITEM.exec(line);
        const accepted = sub ? continuesSubSequence(lastSub, sub[1]) : false;
        if (sub && accepted) lastSub = subItemOrdinal(sub[1]);
        const nextLabel = sub && accepted ? `${top}(${sub[1].toLowerCase()})` : label;
        if (nextLabel !== label) {
          flush();
          label = nextLabel;
        }
      } else {
        const recital = RECITAL.exec(line);
        if (recital && unit.startKind === 'lettered') {
          const nextLabel = `Recital ${recital[1]}`;
          if (nextLabel !== label) {
            flush();
            label = nextLabel;
          }
        }
      }
      text += (text ? '\n' : '') + flatLine.text;
    }
    flush();
  }

  for (const pageNo of pageNos) if (!byPage.has(pageNo)) byPage.set(pageNo, []);
  return { pages, segments, byPage };
}

export interface ResolvedQuote {
  page: number;
  clause: string;
  top: string | null;
  corrected: boolean;
}

function findInPage(index: AnchorIndex, pageNo: number, q: string): ResolvedQuote | null {
  const segs = index.byPage.get(pageNo);
  if (!segs) return null;
  for (const seg of segs) {
    if (seg.norm.includes(q)) return { page: pageNo, clause: seg.clause, top: seg.top, corrected: false };
  }
  // The quote may span two segments; fall back to the page text and take the preceding anchor.
  const pageNorm = normalizeQuote(index.pages.get(pageNo) ?? '');
  const pos = pageNorm.indexOf(q);
  if (pos < 0) return null;
  let best = segs[0];
  for (const seg of segs) {
    const segPos = pageNorm.indexOf(seg.norm.slice(0, Math.min(60, seg.norm.length)));
    if (segPos >= 0 && segPos <= pos) best = seg;
  }
  return { page: pageNo, clause: best?.clause ?? 'preamble', top: best?.top ?? null, corrected: false };
}

// Searches the cited page, then the chunk's page range, then the whole document.
// The returned page/clause are where the quote was actually found.
export function resolveQuote(
  index: AnchorIndex,
  quote: string,
  citedPage: number | null,
  range: { start: number; end: number },
): ResolvedQuote | null {
  const q = normalizeQuote(quote);
  if (q.length < 8) return null;

  const order: number[] = [];
  if (citedPage !== null && index.pages.has(citedPage)) order.push(citedPage);
  for (let p = range.start; p <= range.end; p++) {
    if (!order.includes(p) && index.pages.has(p)) order.push(p);
  }
  for (const p of [...index.pages.keys()].sort((a, b) => a - b)) {
    if (!order.includes(p)) order.push(p);
  }

  for (const p of order) {
    const found = findInPage(index, p, q);
    if (found) {
      found.corrected = citedPage !== null && found.page !== citedPage;
      return found;
    }
  }
  return null;
}

export function topClause(label: string): string {
  return label.replace(/\(.*$/, '');
}
