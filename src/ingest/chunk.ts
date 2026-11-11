export interface PageText {
  pageNo: number;
  text: string;
}

export interface ChunkConfig {
  targetTokens: number;
  maxTokens: number;
  minTokens: number;
  // Hard structure limits. A clause that exceeds either limit is force-closed at the next
  // heading-like line and flagged as unusually long.
  maxClausePages: number;
  maxClauseTokens: number;
  // A top-level number may restart at a low value after at least this many accepted clauses.
  restartMinRun: number;
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  targetTokens: 1250,
  maxTokens: 2500,
  minTokens: 300,
  maxClausePages: 15,
  maxClauseTokens: 6000,
  restartMinRun: 5,
};

export type StartKind = 'clause' | 'subclause' | 'section' | 'lettered' | 'preamble' | 'part' | 'free';

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
  // A numbering restart or a new document/section title starts a new run.
  sectionBreak: boolean;
  // The clause exceeded maxClausePages or maxClauseTokens and was force-closed.
  unusuallyLong: boolean;
  // The chunk's own text with [[pN]] markers, built from the chunk's lines. Analysis input uses
  // this directly instead of re-slicing pages by a clause range.
  pageMarkedText: string;
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
  // One page number per line in text, so a size-split part can recover its own page span.
  linePages: number[];
  sectionBreak: boolean;
  unusuallyLong: boolean;
}

export type LineKind = { kind: 'clause'; no: string } | { kind: 'section'; label: string } | null;

const SECTION_RE = /^\s*(ARTICLE|Article|SCHEDULE|Schedule|ANNEXURE|Annexure|PART|Part|CHAPTER|Chapter)\s+([0-9]{1,3}|[IVXLCDM]{1,6}|[A-Z])\b/;
const CLAUSE_WORD_RE = /^\s*(CLAUSE|Clause)\s+(\d{1,3}(?:\.\d{1,3}){0,4})\b/;
const PAREN_CLAUSE_RE = /^\s*(\d{1,3})\)\s+\S/;
const PAREN_NUM_RE = /^\s*\((\d{1,3})\)\s+(?=\S)/;
const SECTION_NUM_RE = /^\s*(?:Section|SECTION)\s+(\d{1,3})\b[.:]?\s+(?=\S)/;
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
  const numbered = PAREN_NUM_RE.exec(line) ?? SECTION_NUM_RE.exec(line);
  if (numbered) return { kind: 'clause', no: numbered[1] };
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
function tableExit(line: string, seq: SequenceState, restartMinRun: number): boolean {
  if (SECTION_RE.test(line) || isSubHeading(line)) return true;
  const cand = numericCandidate(line);
  // A restart inside a table is a row, not a new clause. Only a continuing sequence exits.
  if (!cand || !checkNumericSequence(seq, cand, restartMinRun, false).accept) return false;
  if (rowLike(line)) return false;
  if (PAREN_CLAUSE_RE.test(line)) return true;
  return line.trim().length > 30;
}

// "bracket" = (N) and "word" = Section N. These styles also appear inside clauses as lists, so
// they only continue a run of the same style; the dotted and paren styles are unrestricted.
type TopStyle = 'dotted' | 'paren' | 'bracket' | 'word' | 'sub';

interface NumericCandidate {
  kind: 'top' | 'sub';
  no: string;
  n: number;
  intPart: number;
  style: TopStyle;
}

function numericCandidate(line: string): NumericCandidate | null {
  const paren = PAREN_CLAUSE_RE.exec(line);
  if (paren) {
    const n = Number(paren[1]);
    return { kind: 'top', no: paren[1], n, intPart: n, style: 'paren' };
  }
  const word = CLAUSE_WORD_RE.exec(line);
  if (word) {
    const n = Number(word[2].split('.')[0]);
    return { kind: 'top', no: word[2], n, intPart: n, style: 'word' };
  }
  const sub = DOTTED_SUB_RE.exec(line);
  if (sub) {
    const no = sub[1];
    return { kind: 'sub', no, n: Number(no.split('.')[0]), intPart: Number(no.split('.')[0]), style: 'sub' };
  }
  const top = DOTTED_TOP_RE.exec(line);
  if (top) {
    const n = Number(top[1]);
    return { kind: 'top', no: top[1], n, intPart: n, style: 'dotted' };
  }
  const bracket = PAREN_NUM_RE.exec(line);
  if (bracket) {
    const n = Number(bracket[1]);
    return { kind: 'top', no: bracket[1], n, intPart: n, style: 'bracket' };
  }
  const section = SECTION_NUM_RE.exec(line);
  if (section) {
    const n = Number(section[1]);
    return { kind: 'top', no: section[1], n, intPart: n, style: 'word' };
  }
  return null;
}

interface SequenceResult {
  accept: boolean;
  gap: string | null;
  restart: boolean;
}

interface SequenceState {
  lastTop: number | null;
  lastStyle: TopStyle | null;
  // Number of accepted top-level clauses in the current run. A restart is allowed only after a
  // real run, not after a single high-numbered clause.
  runLength: number;
  // True when the document also uses dotted or paren clauses: then a bracket or word style only
  // continues a run of its own style, so a preamble list cannot start the clause sequence.
  strict: boolean;
}

function checkNumericSequence(
  state: SequenceState,
  c: NumericCandidate,
  restartMinRun: number,
  allowRestart = true,
): SequenceResult {
  if (c.kind === 'sub') {
    return { accept: state.lastTop !== null && c.intPart === state.lastTop, gap: null, restart: false };
  }
  if ((c.style === 'bracket' || c.style === 'word') && state.lastStyle !== c.style && (state.strict || state.lastTop !== null)) {
    return { accept: false, gap: null, restart: false };
  }
  if (state.lastTop === null) return { accept: true, gap: null, restart: false };
  if (c.n === state.lastTop + 1) return { accept: true, gap: null, restart: false };
  if (c.n > state.lastTop + 1 && c.n <= state.lastTop + 3) {
    return { accept: true, gap: `${state.lastTop + 1}-${c.n - 1}`, restart: false };
  }
  // A new document or schedule may restart numbering at 1 (or another low value) after a run.
  // This is a section break, not a sequence error. Table rows never restart numbering.
  if (allowRestart && state.runLength >= restartMinRun && c.n < state.lastTop && (c.n === 1 || c.n <= 2)) {
    return { accept: true, gap: null, restart: true };
  }
  return { accept: false, gap: null, restart: false };
}

// General heading-like lines: section labels and all-caps or title-word headings. Used only to
// close an over-long clause, so ordinary clause lines are handled by the numbering rules.
const TITLE_WORD_RE =
  /\b(AGREEMENT|DEED|LEASE|LICENCE|LICENSE|SCHEDULE|ANNEXURE|APPENDIX|PART|CHAPTER|ARTICLE|SECTION|MEMORANDUM|UNDERTAKING|DECLARATION|NOTICE|PROSPECTUS|POLICY|TRUST DEED)\b/i;
const ALL_CAPS_HEADING_RE = /^[A-Z0-9][A-Z0-9 &/()'’.,:-]{7,}$/;

function isHeadingLike(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 120) return false;
  if (SECTION_RE.test(t)) return true;
  if (ALL_CAPS_HEADING_RE.test(t) && t.split(/\s+/).length >= 2) return true;
  if (TITLE_WORD_RE.test(t) && !/[.;]$/.test(t) && t.split(/\s+/).length <= 12) return true;
  return false;
}

// A first line on a page that looks like a document/section title rather than a clause. Repeated
// running headers are ignored by the caller after their first occurrence.
function isTitleBlock(line: string): boolean {
  const t = line.trim();
  if (t.length < 8 || t.length > 120) return false;
  if (/[.;:,]$/.test(t)) return false;
  if (numericCandidate(t) || LETTER_RE.test(t) || rowLike(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 3) return false;
  const titleCase = words.filter((w) => /^[A-Z]/.test(w)).length >= Math.ceil(words.length * 0.6);
  return ALL_CAPS_HEADING_RE.test(t) || titleCase;
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

// True when the whole document also uses dotted or paren clauses. Computed once per document so
// that a piece of it (an analysis chunk) gets the same answer as the document.
export function documentStrict(pages: PageText[]): boolean {
  return pages.some((p) => p.text.split('\n').some((l) => DOTTED_TOP_RE.test(l) || PAREN_CLAUSE_RE.test(l)));
}

export interface BuildUnitsOptions {
  strict?: boolean;
  maxClausePages?: number;
  maxClauseTokens?: number;
  restartMinRun?: number;
}

export function buildUnits(pages: PageText[], opts: BuildUnitsOptions = {}): Unit[] {
  const maxClausePages = opts.maxClausePages ?? DEFAULT_CHUNK_CONFIG.maxClausePages;
  const maxClauseTokens = opts.maxClauseTokens ?? DEFAULT_CHUNK_CONFIG.maxClauseTokens;
  const restartMinRun = opts.restartMinRun ?? DEFAULT_CHUNK_CONFIG.restartMinRun;
  const units: Unit[] = [];
  const seq: SequenceState = { lastTop: null, lastStyle: null, runLength: 0, strict: opts.strict ?? documentStrict(pages) };
  const letters: LetterState = { lastLetter: null, restarts: 0 };
  const table = { inTable: false, srArmed: false };
  const pageTitles = new Set<string>();
  let section: string | null = null;
  let current: Unit | null = null;

  const resetSequence = () => {
    seq.lastTop = null;
    seq.lastStyle = null;
    seq.runLength = 0;
    letters.lastLetter = null;
    letters.restarts = 0;
  };

  const pushUnit = (
    startKind: StartKind,
    clauseNo: string | null,
    topClause: string | null,
    heading: string,
    pageNo: number,
    gap: string | null,
    sectionBreak = false,
  ) => {
    if (current && current.text.trim()) units.push(current);
    current = {
      clauseNo,
      topClause,
      startKind,
      heading,
      section,
      pageStart: pageNo,
      pageEnd: pageNo,
      text: '',
      gap,
      linePages: [],
      sectionBreak,
      unusuallyLong: false,
    };
  };

  const append = (line: string, pageNo: number) => {
    if (current === null) pushUnit('preamble', null, null, '', pageNo, null);
    const unit = current as Unit | null;
    if (unit === null) return;
    unit.text += (unit.text ? '\n' : '') + line;
    unit.linePages.push(pageNo);
    unit.pageEnd = pageNo;
  };

  const markOverLimit = () => {
    if (!current) return;
    if (
      current.pageEnd - current.pageStart + 1 > maxClausePages ||
      estimateTokens(current.text) > maxClauseTokens
    ) {
      current.unusuallyLong = true;
    }
  };

  for (const page of pages) {
    const lines = page.text.split('\n');
    let firstContent = true;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      if (!line.trim()) continue;
      const firstOnPage = firstContent;
      firstContent = false;

      // Table lines are kept as text, they just never become boundaries.
      if (table.inTable) {
        const exits = tableExit(line, seq, restartMinRun);
        if (!exits) {
          append(line, page.pageNo);
          markOverLimit();
          continue;
        }
        table.inTable = false;
        table.srArmed = false;
      } else {
        if (SR_NO_RE.test(line) || SR_HEADER_RE.test(line)) {
          table.inTable = true;
          table.srArmed = false;
          append(line, page.pageNo);
          markOverLimit();
          continue;
        }
        if (table.srArmed && NO_HEADER_RE.test(line)) {
          table.inTable = true;
          table.srArmed = false;
          append(line, page.pageNo);
          markOverLimit();
          continue;
        }
        if (rowRun(lines, i)) {
          table.inTable = true;
          append(line, page.pageNo);
          markOverLimit();
          continue;
        }
      }

      const cand = numericCandidate(line);
      const sectionMatch = SECTION_RE.exec(line);

      // Hard rule: an over-long clause is force-closed at the next heading-like line, even when
      // the numbering would otherwise reject that line. Record it as unusually long.
      const currentUnit = current as Unit | null;
      if (
        currentUnit &&
        currentUnit.unusuallyLong &&
        (isHeadingLike(line) || (cand?.kind === 'top' && !rowLike(line)) || sectionMatch !== null)
      ) {
        if (cand && cand.kind === 'top' && !rowLike(line)) {
          resetSequence();
          seq.lastTop = cand.n;
          seq.lastStyle = cand.style;
          seq.runLength = 1;
          pushUnit('clause', cand.no, cand.no, line.trim().slice(0, 120), page.pageNo, null, true);
        } else if (sectionMatch) {
          section = `${sectionMatch[1]} ${sectionMatch[2]}`;
          resetSequence();
          pushUnit('section', null, null, line.trim().slice(0, 120), page.pageNo, null, true);
        } else {
          section = line.trim().slice(0, 120);
          resetSequence();
          pushUnit('section', null, null, line.trim().slice(0, 120), page.pageNo, null, true);
        }
        append(line, page.pageNo);
        markOverLimit();
        continue;
      }

      // A page that starts with a new title block starts a new document/section run. Repeated
      // running headers are not treated as sections.
      if (firstOnPage && !sectionMatch && isTitleBlock(line)) {
        const key = line.trim().toLowerCase();
        if (pageTitles.has(key)) {
          append(line, page.pageNo);
          markOverLimit();
          continue;
        }
        pageTitles.add(key);
        section = line.trim().slice(0, 120);
        resetSequence();
        pushUnit('section', null, null, line.trim().slice(0, 120), page.pageNo, null, true);
        append(line, page.pageNo);
        markOverLimit();
        continue;
      }

      if (sectionMatch) {
        section = `${sectionMatch[1]} ${sectionMatch[2]}`;
        resetSequence();
        pushUnit('section', null, null, line.trim().slice(0, 120), page.pageNo, null, true);
      } else if (cand) {
        const res = checkNumericSequence(seq, cand, restartMinRun, !rowLike(line) && !rowRun(lines, i));
        if (res.accept) {
          if (cand.kind === 'top') {
            if (res.restart) resetSequence();
            seq.lastTop = cand.n;
            seq.lastStyle = cand.style;
            seq.runLength += 1;
            pushUnit('clause', cand.no, cand.no, line.trim().slice(0, 120), page.pageNo, res.gap, res.restart);
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

      append(line, page.pageNo);
      markOverLimit();
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
  if (!(cfg.maxClausePages > 0 && cfg.maxClauseTokens > 0 && cfg.restartMinRun > 0)) {
    throw new Error(`invalid clause limits: ${JSON.stringify(cfg)}`);
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
export interface TextSpan {
  text: string;
  start: number;
  end: number;
}

export function packSentenceSpans(text: string, limitTokens: number): TextSpan[] {
  const limitChars = limitTokens * 4;
  const parts: TextSpan[] = [];
  let cur = '';
  let curStart = 0;
  let offset = 0;
  for (const span of sentenceSpans(text)) {
    if (cur && cur.length + span.length > limitChars) {
      parts.push({ text: cur, start: curStart, end: offset });
      cur = '';
    }
    if (!cur) curStart = offset;
    cur += span;
    offset += span.length;
  }
  if (cur) parts.push({ text: cur, start: curStart, end: offset });
  return parts;
}

export function packSentences(text: string, limitTokens: number): string[] {
  return packSentenceSpans(text, limitTokens).map((p) => p.text);
}

// Maps a character span of the joined clause text back to the pages its lines came from.
function pageRangeForSpan(units: Unit[], start: number, end: number): { pageStart: number; pageEnd: number } {
  let offset = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const unit of units) {
    const lines = unit.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lineStart = offset;
      const lineEnd = offset + lines[i].length;
      if (lineEnd > start && lineStart < end) {
        const page = unit.linePages[i] ?? unit.pageStart;
        min = Math.min(min, page);
        max = Math.max(max, page);
      }
      offset = lineEnd + 1; // the newline after every line
    }
    offset += 1; // the extra newline between units
  }
  return {
    pageStart: min === Number.POSITIVE_INFINITY ? units[0]?.pageStart ?? 1 : min,
    pageEnd: max === Number.NEGATIVE_INFINITY ? units[units.length - 1]?.pageEnd ?? 1 : max,
  };
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
  pageStart: number;
  pageEnd: number;
  start: number;
  end: number;
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
    if (clause[0]?.sectionBreak) closeCur();
    if (ct > cfg.maxTokens) {
      closeCur();
      const parts = packSentenceSpans(text, cfg.targetTokens);
      parts.forEach((part, i) => {
        const range = pageRangeForSpan(clause, part.start, part.end);
        groups.push({
          kind: 'part',
          units: clause,
          text: part.text,
          partIndex: i,
          partCount: parts.length,
          pageStart: range.pageStart,
          pageEnd: range.pageEnd,
          start: part.start,
          end: part.end,
        });
      });
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
    const startsAtBreak = group.kind === 'normal' && group.units[0]?.sectionBreak === true;
    const prevHasBreak = prev?.kind === 'normal' && prev.units.some((u) => u.sectionBreak);
    if (
      prev &&
      prev.kind === 'normal' &&
      group.kind === 'normal' &&
      !startsAtBreak &&
      !prevHasBreak &&
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

function pageMarkedUnits(units: Unit[]): string {
  const out: string[] = [];
  let last: number | null = null;
  for (const unit of units) {
    const lines = unit.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const page = unit.linePages[i] ?? unit.pageStart;
      if (page !== last) {
        out.push(`[[p${page}]]`);
        last = page;
      }
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

function pageMarkedSpan(units: Unit[], start: number, end: number, text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let last: number | null = null;
  let offset = 0;
  for (const line of lines) {
    const abs = start + offset;
    let page = units[0]?.pageStart ?? 1;
    let cursor = 0;
    for (const unit of units) {
      const unitLines = unit.text.split('\n');
      for (let i = 0; i < unitLines.length; i++) {
        const lineStart = cursor;
        const lineEnd = cursor + unitLines[i].length;
        if (abs >= lineStart && abs <= lineEnd) page = unit.linePages[i] ?? unit.pageStart;
        cursor = lineEnd + 1;
      }
      cursor += 1;
    }
    if (page !== last) {
      out.push(`[[p${page}]]`);
      last = page;
    }
    out.push(line);
    offset += line.length + 1;
  }
  void end;
  return out.join('\n');
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
      pageStart: group.pageStart,
      pageEnd: group.pageEnd,
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
      sectionBreak: group.units.some((u) => u.sectionBreak),
      unusuallyLong: group.units.some((u) => u.unusuallyLong),
      pageMarkedText: pageMarkedSpan(group.units, group.start, group.end, text),
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
    sectionBreak: group.units.some((u) => u.sectionBreak),
    unusuallyLong: group.units.some((u) => u.unusuallyLong),
    pageMarkedText: pageMarkedUnits(group.units),
  };
}

export function chunkDocument(pages: PageText[], overrides: Partial<ChunkConfig> = {}): Chunk[] {
  const cfg = resolveChunkConfig(overrides);
  return chunkUnits(
    buildUnits(pages, {
      maxClausePages: cfg.maxClausePages,
      maxClauseTokens: cfg.maxClauseTokens,
      restartMinRun: cfg.restartMinRun,
    }),
    overrides,
  );
}

// Structure-free fallback: cut at sentence ends, about targetTokens per chunk with a short
// overlap. Used only when the structured result is not trustworthy.
export interface FreeChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
  maxTokens?: number;
}

export function structureFreeChunks(pages: PageText[], opts: FreeChunkOptions = {}): Chunk[] {
  const target = opts.targetTokens ?? 1000;
  const max = opts.maxTokens ?? Math.max(target, 1200);
  const overlap = opts.overlapTokens ?? 100;

  const items: { text: string; page: number }[] = [];
  for (const page of pages) {
    for (const span of sentenceSpans(page.text)) {
      const text = span.trim();
      if (text) items.push({ text, page: page.pageNo });
    }
  }

  const chunks: Chunk[] = [];
  let cur: { text: string; page: number }[] = [];
  let curTokens = 0;

  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((x) => x.text).join(' ').trim();
    if (!text) {
      cur = [];
      curTokens = 0;
      return;
    }
    const pagesIn = cur.map((x) => x.page);
    const marked: string[] = [];
    let lastPage: number | null = null;
    for (const item of cur) {
      if (item.page !== lastPage) {
        marked.push(`[[p${item.page}]]`);
        lastPage = item.page;
      }
      marked.push(item.text);
    }
    chunks.push({
      index: chunks.length,
      text,
      carried: null,
      pageStart: Math.min(...pagesIn),
      pageEnd: Math.max(...pagesIn),
      clauseFrom: null,
      clauseTo: null,
      clauses: [],
      startKind: 'free',
      heading: null,
      parentSection: null,
      tokenEst: estimateTokens(text),
      units: cur.length,
      split: false,
      partIndex: null,
      partCount: null,
      sectionBreak: false,
      unusuallyLong: false,
      pageMarkedText: marked.join('\n'),
    });
    const ov: { text: string; page: number }[] = [];
    let ot = 0;
    for (let i = cur.length - 1; i >= 0; i--) {
      const t = estimateTokens(cur[i].text);
      if (ot + t > overlap) break;
      ov.unshift(cur[i]);
      ot += t;
    }
    cur = ov;
    curTokens = ot;
  };

  for (const item of items) {
    const t = estimateTokens(item.text);
    if (cur.length > 0 && curTokens + t > target) flush();

    if (t > max) {
      // A single sentence longer than the maximum is cut at word boundaries.
      let piece = '';
      for (const word of item.text.split(/\s+/)) {
        const next = piece ? `${piece} ${word}` : word;
        if (piece && estimateTokens(next) > target) {
          cur.push({ text: piece, page: item.page });
          curTokens += estimateTokens(piece);
          flush();
          piece = word;
        } else {
          piece = next;
        }
      }
      if (piece) {
        cur.push({ text: piece, page: item.page });
        curTokens += estimateTokens(piece);
      }
    } else {
      cur.push(item);
      curTokens += t;
    }
  }
  flush();
  return chunks;
}
