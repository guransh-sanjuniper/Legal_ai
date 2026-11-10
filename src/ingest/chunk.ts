export interface PageText {
  pageNo: number;
  text: string;
}

export interface ChunkConfig {
  targetTokens: number;
  maxTokens: number;
  minTokens: number;
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  targetTokens: 1250,
  maxTokens: 2500,
  minTokens: 300,
};

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
  split: boolean;
  partIndex: number | null;
  partCount: number | null;
}

export interface Unit {
  clauseNo: string | null;
  heading: string | null;
  section: string | null;
  pageStart: number;
  pageEnd: number;
  text: string;
}

export type LineKind = { kind: 'clause'; no: string } | { kind: 'section'; label: string } | null;

const SECTION_RE = /^\s*(ARTICLE|Article|SCHEDULE|Schedule|ANNEXURE|Annexure|PART|Part|CHAPTER|Chapter)\s+([0-9]{1,3}|[IVXLCDM]{1,6}|[A-Z])\b/;
const ROMAN_HEADING_RE = /^\s*([IVXLC]{1,6})\.\s+[A-Z]/;
const CLAUSE_WORD_RE = /^\s*(CLAUSE|Clause)\s+(\d{1,3}(?:\.\d{1,3}){0,4})\b/;
const NUMBERED_RE = /^\s*(\d{1,3}(?:\.\d{1,3}){0,4})\.?\s+(?=[A-Z("'“])/;
const PAREN_NUMBER_RE = /^\s*\((\d{1,3})\)\s+(?=[A-Z])/;
const SENTENCE_END_RE = /[.!?;]+["')\]]*\s+/g;

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

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function resolveChunkConfig(overrides: Partial<ChunkConfig> = {}): ChunkConfig {
  const cfg = { ...DEFAULT_CHUNK_CONFIG, ...overrides };
  if (!(cfg.minTokens > 0 && cfg.minTokens <= cfg.targetTokens && cfg.targetTokens <= cfg.maxTokens)) {
    throw new Error(`invalid chunk config: need 0 < min <= target <= max, got ${JSON.stringify(cfg)}`);
  }
  return cfg;
}

// Splits text into sentence-ending spans. Joining the spans gives back the exact input.
export function sentenceSpans(text: string): string[] {
  const spans: string[] = [];
  let start = 0;
  const re = new RegExp(SENTENCE_END_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    spans.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) spans.push(text.slice(start));
  return spans;
}

function hardSplit(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

// Packs sentences into parts of at most limitTokens. A single sentence longer than the limit is cut at a space.
export function packSentences(text: string, limitTokens: number): string[] {
  const limitChars = limitTokens * 4;
  const parts: string[] = [];
  let cur = '';
  for (const span of sentenceSpans(text)) {
    if (span.length > limitChars) {
      if (cur) parts.push(cur);
      cur = '';
      parts.push(...hardSplit(span, limitChars));
      continue;
    }
    if (cur && cur.length + span.length > limitChars) {
      parts.push(cur);
      cur = '';
    }
    cur += span;
  }
  if (cur) parts.push(cur);
  return parts;
}

interface NormalGroup {
  kind: 'normal';
  units: Unit[];
}

interface PartGroup {
  kind: 'part';
  unit: Unit;
  text: string;
  partIndex: number;
  partCount: number;
}

type Group = NormalGroup | PartGroup;

function groupTokens(group: Group): number {
  return estimateTokens(group.kind === 'normal' ? group.units.map((u) => u.text).join('\n\n') : group.text);
}

function groupText(group: Group): string {
  return group.kind === 'normal' ? group.units.map((u) => u.text).join('\n\n') : group.text;
}

export function chunkUnits(units: Unit[], overrides: Partial<ChunkConfig> = {}): Chunk[] {
  const cfg = resolveChunkConfig(overrides);
  const groups: Group[] = [];
  let cur: Unit[] = [];
  let curTokens = 0;

  const closeCur = () => {
    if (cur.length) groups.push({ kind: 'normal', units: cur });
    cur = [];
    curTokens = 0;
  };

  for (const unit of units) {
    const ut = estimateTokens(unit.text);
    if (ut > cfg.maxTokens) {
      closeCur();
      const parts = packSentences(unit.text, cfg.targetTokens);
      parts.forEach((text, i) => groups.push({ kind: 'part', unit, text, partIndex: i, partCount: parts.length }));
      continue;
    }
    if (cur.length > 0) {
      const sectionChanged = unit.section !== cur[0].section;
      const wouldOverflow = curTokens + ut > cfg.maxTokens;
      const targetReached = curTokens >= cfg.targetTokens;
      const sectionDone = sectionChanged && curTokens >= cfg.minTokens;
      if (wouldOverflow || targetReached || sectionDone) closeCur();
    }
    cur.push(unit);
    curTokens += ut;
  }
  closeCur();

  // Merge any small chunk into its previous chunk, if the result still fits the max.
  const merged: Group[] = [];
  for (const group of groups) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.kind === 'normal' &&
      group.kind === 'normal' &&
      groupTokens(group) < cfg.minTokens &&
      groupTokens(prev) + groupTokens(group) <= cfg.maxTokens
    ) {
      prev.units = prev.units.concat(group.units);
    } else {
      merged.push(group);
    }
  }

  return merged.map((group, index) => toChunk(group, index, merged));
}

function toChunk(group: Group, index: number, all: Group[]): Chunk {
  const text = groupText(group);
  const prev = all[index - 1];
  const carried = prev ? (prev.kind === 'normal' ? prev.units[prev.units.length - 1].text : prev.text) : null;

  if (group.kind === 'part') {
    const u = group.unit;
    return {
      index,
      text,
      carried,
      pageStart: u.pageStart,
      pageEnd: u.pageEnd,
      clauseFrom: u.clauseNo,
      clauseTo: u.clauseNo,
      heading: u.heading,
      parentSection: u.section,
      tokenEst: estimateTokens(text),
      units: 1,
      split: true,
      partIndex: group.partIndex,
      partCount: group.partCount,
    };
  }

  const clauses = group.units.map((u) => u.clauseNo).filter((c): c is string => c !== null);
  const first = group.units[0];
  return {
    index,
    text,
    carried,
    pageStart: Math.min(...group.units.map((u) => u.pageStart)),
    pageEnd: Math.max(...group.units.map((u) => u.pageEnd)),
    clauseFrom: clauses[0] ?? null,
    clauseTo: clauses[clauses.length - 1] ?? null,
    heading: first.heading,
    parentSection: first.section,
    tokenEst: estimateTokens(text),
    units: group.units.length,
    split: false,
    partIndex: null,
    partCount: null,
  };
}

export function chunkDocument(pages: PageText[], overrides: Partial<ChunkConfig> = {}): Chunk[] {
  return chunkUnits(buildUnits(pages), overrides);
}
