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

const SUB_PAREN = /^\s*\(([a-zA-Z]{1,4}|\d{1,3})\)\s+\S/;
const SUB_LETTER = /^\s*([a-z])\)\s+\S/;
const RECITAL = /^\s*([A-Z])\.\s+\S/;

interface FlatLine {
  page: number;
  text: string;
}

// Anchors come from the same table-aware unit detection used for chunking, so table rows
// never become clause labels. Sub-items inside a unit get a composed label such as 23(a).
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

  for (const unit of units) {
    const lines = unit.text.split('\n');
    const top = unit.clauseNo;
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
        const sub = SUB_PAREN.exec(line) ?? SUB_LETTER.exec(line);
        const nextLabel = sub ? `${top}(${sub[1].toLowerCase()})` : top;
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
