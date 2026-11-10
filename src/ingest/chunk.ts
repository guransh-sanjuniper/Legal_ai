export interface PageText {
  pageNo: number;
  text: string;
}

export interface Chunk {
  index: number;
  text: string;
  carried: string | null;
  pageStart: number;
  pageEnd: number;
  clauseFrom: string | null;
  clauseTo: string | null;
  heading: string | null;
  parentSection: string | null;
  tokenEst: number;
  units: number;
  oversize: boolean;
}

export interface Unit {
  clauseNo: string | null;
  heading: string | null;
  section: string | null;
  pageStart: number;
  pageEnd: number;
  text: string;
}

export interface ChunkOptions {
  maxTokens?: number;
}

export type LineKind = { kind: 'clause'; no: string } | { kind: 'section'; label: string } | null;

const SECTION_RE = /^\s*(ARTICLE|Article|SCHEDULE|Schedule|ANNEXURE|Annexure|PART|Part|CHAPTER|Chapter)\s+([0-9]{1,3}|[IVXLCDM]{1,6}|[A-Z])\b/;
const ROMAN_HEADING_RE = /^\s*([IVXLC]{1,6})\.\s+[A-Z]/;
const CLAUSE_WORD_RE = /^\s*(CLAUSE|Clause)\s+(\d{1,3}(?:\.\d{1,3}){0,4})\b/;
const NUMBERED_RE = /^\s*(\d{1,3}(?:\.\d{1,3}){0,4})\.?\s+(?=[A-Z("'“])/;
const PAREN_NUMBER_RE = /^\s*\((\d{1,3})\)\s+(?=[A-Z])/;

export function classifyLine(line: string): LineKind {
  const section = SECTION_RE.exec(line);
  if (section) return { kind: 'section', label: `${section[1]} ${section[2]}` };
  const roman = ROMAN_HEADING_RE.exec(line);
  if (roman) return { kind: 'section', label: roman[1] };
  const clauseWord = CLAUSE_WORD_RE.exec(line);
  if (clauseWord) return { kind: 'clause', no: clauseWord[2] };
  const numbered = NUMBERED_RE.exec(line);
  if (numbered) return { kind: 'clause', no: numbered[1] };
  const paren = PAREN_NUMBER_RE.exec(line);
  if (paren) return { kind: 'clause', no: `(${paren[1]})` };
  return null;
}

export function buildUnits(pages: PageText[]): Unit[] {
  const units: Unit[] = [];
  let section: string | null = null;
  let current: Unit | null = null;

  for (const page of pages) {
    for (const rawLine of page.text.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line.trim()) continue;
      const kind = classifyLine(line);

      if (kind !== null) {
        if (current && current.text.trim()) units.push(current);
        const isSection = kind.kind === 'section';
        if (isSection) section = kind.label;
        current = {
          clauseNo: kind.kind === 'clause' ? kind.no : null,
          heading: line.trim().slice(0, 120),
          section,
          pageStart: page.pageNo,
          pageEnd: page.pageNo,
          text: '',
        };
      } else if (current === null) {
        current = { clauseNo: null, heading: null, section, pageStart: page.pageNo, pageEnd: page.pageNo, text: '' };
      }

      current.text += (current.text ? '\n' : '') + line;
      current.pageEnd = page.pageNo;
    }
  }
  if (current && (current as Unit).text.trim()) units.push(current);
  return units;
}

export function chunkUnits(units: Unit[], options: ChunkOptions = {}): Chunk[] {
  const maxChars = (options.maxTokens ?? 8000) * 4;
  const chunks: Chunk[] = [];
  let group: Unit[] = [];
  let groupChars = 0;
  let carried: string | null = null;

  const flush = (oversize: boolean) => {
    if (group.length === 0) return;
    const text = group.map((u) => u.text).join('\n\n');
    const first = group[0];
    const last = group[group.length - 1];
    const clauses = group.map((u) => u.clauseNo).filter((c): c is string => c !== null);
    chunks.push({
      index: chunks.length,
      text,
      carried,
      pageStart: Math.min(...group.map((u) => u.pageStart)),
      pageEnd: Math.max(...group.map((u) => u.pageEnd)),
      clauseFrom: clauses[0] ?? null,
      clauseTo: clauses[clauses.length - 1] ?? null,
      heading: first.heading,
      parentSection: first.section,
      tokenEst: Math.ceil(text.length / 4),
      units: group.length,
      oversize,
    });
    carried = last.text;
    group = [];
    groupChars = 0;
  };

  for (const unit of units) {
    const size = unit.text.length;
    if (size > maxChars) {
      flush(false);
      group = [unit];
      groupChars = size;
      flush(true);
      continue;
    }
    if (group.length > 0 && groupChars + size + 2 > maxChars) flush(false);
    group.push(unit);
    groupChars += size + 2;
  }
  flush(false);
  return chunks;
}

export function chunkDocument(pages: PageText[], options: ChunkOptions = {}): Chunk[] {
  return chunkUnits(buildUnits(pages), options);
}
