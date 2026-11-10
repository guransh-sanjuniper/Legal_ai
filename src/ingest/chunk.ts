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

export type StartKind = 'clause' | 'subclause' | 'section' | 'lettered' | 'preamble' | 'part';

export interface Chunk {
  index: number;
  text: string;
  carried: string | null;
  pageStart: number;
  pageEnd: number;
  clauseFrom: string | null;
  clauseTo: string | null;
  clauses: string[];
  startKind: StartKind;
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
  topClause: string | null;
  startKind: StartKind;
  heading: string | null;
  section: string | null;
  pageStart: number;
  pageEnd: number;
  text: string;
  gap: string | null;
}

export type LineKind = { kind: 'clause'; no: string } | { kind: 'section'; label: string } | null;

const SECTION_RE = /^\s*(ARTICLE|Article|SCHEDULE|Schedule|ANNEXURE|Annexure|PART|Part|CHAPTER|Chapter)\s+([0-9]{1,3}|[IVXLCDM]{1,6}|[A-Z])\b/;
const CLAUSE_WORD_RE = /^\s*(CLAUSE|Clause)\s+(\d{1,3}(?:\.\d{1,3}){0,4})\b/;
const PAREN_CLAUSE_RE = /^\s*(\d{1,3})\)\s+\S/;
const DOTTED_TOP_RE = /^\s*(\d{1,3})\.\s+(?=\S)/;
const DOTTED_SUB_RE = /^\s*(\d{1,3}(?:\.\d{1,3}){1,3})\.?\s+(?=\S)/;
const LETTER_RE = /^\s*([A-Z])\.\s+(?=\S)/;
const SENTENCE_END_RE = /[.!?;]+["')\]]*\s+/g;

// Table detection. A "Sr. / no." header is split over two lines in real PDFs.
const SR_HEADER_RE = /^\s*Sr\.?\s*$/i;
const SR_NO_RE = /^\s*Sr\.?\s*no\.?\s*$/i;
const NO_HEADER_RE = /^\s*No\.?\s*$/i;
const NUMBER_ROW_RE = /^\s*(\d{1,3})(?:\.\d{1,3})?[.)]?\s+(\S.*)$/;
const ROW_SIGNAL_RE = /(?:Mr|Mrs|Ms|Shri|Smt)\.?\s|Rs\.?|\/-|\b[A-Z]{1,2}-?\d{1,4}\b/;
const SUB_HEADING_RE = /^\s*[a-z]\)\s+[A-Z][A-Z0-9 &/()'’.,-]{3,}/;

export function classifyLine(line: string): LineKind {
  const section = SECTION_RE.exec(line);
  if (section) return { kind: 'section', label: `${section[1]} ${section[2]}` };
  const clauseWord = CLAUSE_WORD_RE.exec(line);
  if (clauseWord) return { kind: 'clause', no: clauseWord[2] };
  const paren = PAREN_CLAUSE_RE.exec(line);
  if (paren) return { kind: 'clause', no: paren[1] };
  const sub = DOTTED_SUB_RE.exec(line);
  if (sub) return { kind: 'clause', no: sub[1] };
  const dotted = DOTTED_TOP_RE.exec(line);
  if (dotted) return { kind: 'clause', no: dotted[1] };
  return null;
}

function isSubHeading(line: string): boolean {
  return SUB_HEADING_RE.test(line);
}

function rowLike(line: string): boolean {
  const m = NUMBER_ROW_RE.exec(line);
  if (!m) return false;
  if (line.trim().length > 75) return false;
  return ROW_SIGNAL_RE.test(line);
}

function rowRun(lines: string[], i: number): boolean {
  if (!rowLike(lines[i])) return false;
  return rowLike(lines[i + 1] ?? '') || rowLike(lines[i + 2] ?? '');
}

// A table ends at a section heading, a sub-heading like "d) COMMERCIAL UNITS:", or a
// sequence-continuing clause that is not itself a table row.
function tableExit(line: string, seq: { lastTop: number | null }): boolean {
  if (SECTION_RE.test(line) || isSubHeading(line)) return true;
  const cand = numericCandidate(line);
  if (!cand || !checkNumericSequence(seq, cand).accept) return false;
  if (rowLike(line)) return false;
  if (PAREN_CLAUSE_RE.test(line)) return true;
  return line.trim().length > 30;
}

interface NumericCandidate {
  kind: 'top' | 'sub';
  no: string;
  n: number;
  intPart: number;
}

function numericCandidate(line: string): NumericCandidate | null {
  const paren = PAREN_CLAUSE_RE.exec(line);
  if (paren) {
    const n = Number(paren[1]);
    return { kind: 'top', no: paren[1], n, intPart: n };
  }
  const word = CLAUSE_WORD_RE.exec(line);
  if (word) {
    const n = Number(word[2].split('.')[0]);
    return { kind: 'top', no: word[2], n, intPart: n };
  }
  const sub = DOTTED_SUB_RE.exec(line);
  if (sub) {
    const no = sub[1];
    return { kind: 'sub', no, n: Number(no.split('.')[0]), intPart: Number(no.split('.')[0]) };
  }
  const top = DOTTED_TOP_RE.exec(line);
  if (top) {
    const n = Number(top[1]);
    return { kind: 'top', no: top[1], n, intPart: n };
  }
  return null;
}

interface SequenceResult {
  accept: boolean;
  gap: string | null;
}

function checkNumericSequence(state: { lastTop: number | null }, c: NumericCandidate): SequenceResult {
  if (c.kind === 'sub') {
    return { accept: state.lastTop !== null && c.intPart === state.lastTop, gap: null };
  }
  if (state.lastTop === null) return { accept: true, gap: null };
  if (c.n === state.lastTop + 1) return { accept: true, gap: null };
  if (c.n > state.lastTop + 1 && c.n <= state.lastTop + 3) {
    return { accept: true, gap: `${state.lastTop + 1}-${c.n - 1}` };
  }
  return { accept: false, gap: null };
}

const LETTER_INDEX = (ch: string) => ch.charCodeAt(0) - 64;

interface LetterState {
  lastLetter: number | null;
  restarts: number;
}

function checkLetterSequence(state: LetterState, letter: string): boolean {
  const idx = LETTER_INDEX(letter);
  if (!Number.isFinite(idx) || idx < 1 || idx > 26) return false;
  if (state.lastLetter === null) return true;
  if (idx === state.lastLetter + 1) return true;
  if (idx === 1 && state.restarts < 1) return true;
  return false;
}

export function buildUnits(pages: PageText[]): Unit[] {
  const units: Unit[] = [];
  const seq = { lastTop: null as number | null };
  const letters: LetterState = { lastLetter: null, restarts: 0 };
  const table = { inTable: false, srArmed: false };
  let section: string | null = null;
  let current: Unit | null = null;

  const pushUnit = (startKind: StartKind, clauseNo: string | null, topClause: string | null, heading: string, pageNo: number, gap: string | null) => {
    if (current && current.text.trim()) units.push(current);
    current = { clauseNo, topClause, startKind, heading, section, pageStart: pageNo, pageEnd: pageNo, text: '', gap };
  };

  const append = (line: string, pageNo: number) => {
    if (current === null) pushUnit('preamble', null, null, '', pageNo, null);
    const unit = current as Unit | null;
    if (unit === null) return;
    unit.text += (unit.text ? '\n' : '') + line;
    unit.pageEnd = pageNo;
  };

  for (const page of pages) {
    const lines = page.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      if (!line.trim()) continue;

      // Table lines are kept as text, they just never become boundaries.
      if (table.inTable) {
        const exits = tableExit(line, seq);
        if (!exits) {
          append(line, page.pageNo);
          continue;
        }
        table.inTable = false;
        table.srArmed = false;
      } else {
        if (SR_NO_RE.test(line)) {
          table.inTable = true;
          append(line, page.pageNo);
          continue;
        }
        if (SR_HEADER_RE.test(line)) {
          table.srArmed = true;
          append(line, page.pageNo);
          continue;
        }
        if (table.srArmed && NO_HEADER_RE.test(line)) {
          table.inTable = true;
          table.srArmed = false;
          append(line, page.pageNo);
          continue;
        }
        if (rowRun(lines, i)) {
          table.inTable = true;
          append(line, page.pageNo);
          continue;
        }
      }

      const sectionMatch = SECTION_RE.exec(line);
      if (sectionMatch) {
        section = `${sectionMatch[1]} ${sectionMatch[2]}`;
        pushUnit('section', null, null, line.trim().slice(0, 120), page.pageNo, null);
      } else {
        const cand = numericCandidate(line);
        if (cand) {
          const res = checkNumericSequence(seq, cand);
          if (res.accept) {
            if (cand.kind === 'top') {
              seq.lastTop = cand.n;
              pushUnit('clause', cand.no, cand.no, line.trim().slice(0, 120), page.pageNo, res.gap);
            } else {
              pushUnit('subclause', cand.no, seq.lastTop === null ? null : String(seq.lastTop), line.trim().slice(0, 120), page.pageNo, null);
            }
          }
        } else {
          const letter = LETTER_RE.exec(line);
          if (letter && checkLetterSequence(letters, letter[1])) {
            const idx = LETTER_INDEX(letter[1]);
            if (letters.lastLetter !== null && idx === 1) letters.restarts++;
            letters.lastLetter = idx;
            pushUnit('lettered', null, null, line.trim().slice(0, 120), page.pageNo, null);
          }
        }
      }

      append(line, page.pageNo);
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

// Sentence-ending spans. Joining them gives back the exact input.
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

// Packs sentences into parts. Splits only between sentences, never inside one.
export function packSentences(text: string, limitTokens: number): string[] {
  const limitChars = limitTokens * 4;
  const parts: string[] = [];
  let cur = '';
  for (const span of sentenceSpans(text)) {
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
  units: Unit[];
  text: string;
  partIndex: number;
  partCount: number;
}

type Group = NormalGroup | PartGroup;

function unitsToText(units: Unit[]): string {
  return units.map((u) => u.text).join('\n\n');
}

function groupTokens(group: Group): number {
  return estimateTokens(group.kind === 'normal' ? group.units.map((u) => u.text).join('\n\n') : group.text);
}

function groupText(group: Group): string {
  return group.kind === 'normal' ? group.units.map((u) => u.text).join('\n\n') : group.text;
}

// A clause and its sub-clauses are one atomic group: they are never separated except by a size split.
function clauseGroups(units: Unit[]): Unit[][] {
  const groups: Unit[][] = [];
  let cur: Unit[] = [];
  let key: string | null = null;
  for (const unit of units) {
    if (cur.length > 0 && unit.topClause !== key) {
      groups.push(cur);
      cur = [];
    }
    cur.push(unit);
    key = unit.topClause;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function topClausesOf(units: Unit[]): string[] {
  const seen: string[] = [];
  for (const u of units) {
    const c = u.topClause;
    if (c !== null && !seen.includes(c)) seen.push(c);
  }
  return seen;
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

  for (const clause of clauseGroups(units)) {
    const text = unitsToText(clause);
    const ct = estimateTokens(text);
    if (ct > cfg.maxTokens) {
      closeCur();
      const parts = packSentences(text, cfg.targetTokens);
      parts.forEach((partText, i) => groups.push({ kind: 'part', units: clause, text: partText, partIndex: i, partCount: parts.length }));
      continue;
    }
    if (cur.length > 0) {
      const sectionChanged = clause[0].section !== cur[0].section;
      const wouldOverflow = curTokens + ct > cfg.maxTokens;
      const targetReached = curTokens >= cfg.targetTokens;
      const sectionDone = sectionChanged && curTokens >= cfg.minTokens;
      if (wouldOverflow || targetReached || sectionDone) closeCur();
    }
    cur.push(...clause);
    curTokens += ct;
  }
  closeCur();

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
    const first = group.units[0];
    const clause = first.topClause ?? first.clauseNo;
    return {
      index,
      text,
      carried,
      pageStart: Math.min(...group.units.map((u) => u.pageStart)),
      pageEnd: Math.max(...group.units.map((u) => u.pageEnd)),
      clauseFrom: clause,
      clauseTo: clause,
      clauses: clause === null ? [] : [clause],
      startKind: 'part',
      heading: first.heading,
      parentSection: first.section,
      tokenEst: estimateTokens(text),
      units: group.units.length,
      split: true,
      partIndex: group.partIndex,
      partCount: group.partCount,
    };
  }

  const first = group.units[0];
  const clauseUnits = group.units.filter((u) => u.clauseNo !== null);
  return {
    index,
    text,
    carried,
    pageStart: Math.min(...group.units.map((u) => u.pageStart)),
    pageEnd: Math.max(...group.units.map((u) => u.pageEnd)),
    clauseFrom: clauseUnits[0]?.clauseNo ?? null,
    clauseTo: clauseUnits[clauseUnits.length - 1]?.clauseNo ?? null,
    clauses: topClausesOf(group.units),
    startKind: first.startKind,
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
