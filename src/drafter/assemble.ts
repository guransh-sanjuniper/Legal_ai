import { numbering } from './outline';
import { itemFingerprint } from './write';
import type { DraftRecord, OutlineItem, OutlineKind } from './types';

// D6: turn the outline and the written clauses into one ordered block list, plus the counts the
// review screen and the export gate need. Pure: no UI, no model, no storage.

export type DraftBlock =
  | { kind: 'title'; text: string }
  | { kind: 'subtitle'; text: string }
  // sectionKind is additive: the writer centres preambles, breaks pages before schedules and lays
  // out signature blocks from it. Consumers that do not know it keep working.
  | { kind: 'heading'; level: 1 | 2; number: string; text: string; sectionKind?: OutlineKind }
  | { kind: 'paragraph'; text: string }
  | { kind: 'table'; columns: string[]; rows: string[][] };

export interface DraftStats {
  sections: number;
  placeholders: number;
  unknownRefs: number;
  staleSections: number;
  failedSections: number;
  pendingSections: number;
}

export interface AssembledDraft {
  blocks: DraftBlock[];
  stats: DraftStats;
}

export interface ExportGate {
  allowed: boolean;
  blockers: string[];
  warnings: string[];
}

function countPlaceholders(text: string): number {
  return (text.match(/\[●/g) ?? []).length;
}

function renderRefs(
  text: string,
  items: OutlineItem[],
  labels: string[],
  stats: DraftStats,
): string {
  const map = new Map(items.map((item, index) => [`S${index + 1}`, labels[index] || item.title]));
  return text.replace(/\{\{ref:(S\d+)\}\}/g, (_whole, id: string) => {
    const label = map.get(id);
    if (label === undefined) {
      stats.unknownRefs++;
      return '[unknown reference]';
    }
    return label;
  });
}

function parseRow(line: string): string[] {
  const cells = line.split('|').map((cell) => cell.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

const SEPARATOR = /^:?-{3,}:?$/;

function textBlocks(text: string): DraftBlock[] {
  const blocks: DraftBlock[] = [];
  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;

    if (lines.length >= 2 && lines.every((line) => line.includes('|'))) {
      const parsed = lines.map(parseRow).filter((row) => row.length > 0);
      const rows = parsed.filter((row, index) => !(index > 0 && row.every((cell) => SEPARATOR.test(cell))));
      if (rows.length >= 2) {
        const [columns, ...data] = rows;
        blocks.push({ kind: 'table', columns, rows: data });
        continue;
      }
    }

    blocks.push({ kind: 'paragraph', text: lines.join('\n') });
  }
  return blocks;
}

export function assemble(draft: DraftRecord): AssembledDraft {
  const plan = draft.sourcePlan;
  const items = draft.outline?.items ?? [];
  const labels = numbering(items);
  const title = draft.title.trim() || plan?.docType?.trim() || 'Draft';
  const docType = plan?.docType?.trim() ?? '';

  const blocks: DraftBlock[] = [{ kind: 'title', text: title }];
  if (docType && docType !== title) blocks.push({ kind: 'subtitle', text: docType });

  const stats: DraftStats = {
    sections: items.length,
    placeholders: 0,
    unknownRefs: 0,
    staleSections: 0,
    failedSections: 0,
    pendingSections: 0,
  };

  items.forEach((item, index) => {
    blocks.push({
      kind: 'heading',
      level: item.level,
      number: labels[index] ?? '',
      text: item.title,
      sectionKind: item.kind,
    });

    const record = draft.clauses[item.id];
    if (!record) {
      stats.pendingSections++;
      return;
    }
    if (record.status === 'failed') {
      stats.failedSections++;
      return;
    }
    if (record.status === 'pending' || record.status === 'writing') {
      stats.pendingSections++;
      return;
    }

    if (record.itemFingerprint !== itemFingerprint(item, draft)) stats.staleSections++;
    const text = renderRefs(record.text, items, labels, stats);
    stats.placeholders += countPlaceholders(text);
    for (const block of textBlocks(text)) blocks.push(block);
  });

  return { blocks, stats };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

export function exportGate(stats: DraftStats): ExportGate {
  const blockers: string[] = [];
  if (stats.sections === 0) blockers.push('There are no sections to download.');
  if (stats.pendingSections > 0) {
    blockers.push(
      `${stats.pendingSections} ${plural(stats.pendingSections, 'section has', 'sections have')} not been written yet.`,
    );
  }
  if (stats.failedSections > 0) {
    blockers.push(
      `${stats.failedSections} ${plural(stats.failedSections, 'section')} could not be written.`,
    );
  }

  const warnings: string[] = [];
  if (stats.placeholders > 0) {
    warnings.push(
      `${stats.placeholders} ${plural(stats.placeholders, 'detail is', 'details are')} still marked [●].`,
    );
  }
  if (stats.staleSections > 0) {
    warnings.push(
      `${stats.staleSections} ${plural(stats.staleSections, 'section')} changed after ${stats.staleSections === 1 ? 'it was' : 'they were'} written.`,
    );
  }
  if (stats.unknownRefs > 0) {
    warnings.push(
      `${stats.unknownRefs} cross-reference${stats.unknownRefs === 1 ? '' : 's'} could not be matched.`,
    );
  }

  return { allowed: blockers.length === 0, blockers, warnings };
}

// ---------- Layout helpers (D6.1) ----------
// Pure and shared by the DOCX writer and the review screen, so the file and the screen agree.
// Nothing here changes text: headings only lose a schedule number the title already repeats.

const SCHEDULE_SEPARATOR = /^[\s:.\-–—]/;

// The heading title without a leading copy of its own number ("Schedule 1 - Floor Plans" under
// number "Schedule 1" becomes "Floor Plans"). An empty string means the title was only the number.
export function headingTitle(block: { number: string; text: string }): string {
  const number = block.number.trim();
  const text = block.text.trim();
  if (!number) return block.text;
  if (!text.toLowerCase().startsWith(number.toLowerCase())) return block.text;
  const rest = text.slice(number.length);
  // "Schedule 10" must not lose "Schedule 1": the number has to end there.
  if (rest !== '' && !SCHEDULE_SEPARATOR.test(rest)) return block.text;
  return rest.replace(/^[\s:.\-–—]+/, '').trim();
}

// The label shown for a heading: the code-generated number plus the title.
export function headingLabel(block: { number: string; text: string }): string {
  const number = block.number.trim();
  if (!number) return block.text;
  const title = headingTitle(block);
  return title ? `${number} ${title}` : number;
}

export type ListKind = 'number' | 'letter' | 'roman';

export interface ListLine {
  // The original line, unchanged. Markers are never renumbered or reordered.
  text: string;
  kind: ListKind | null;
  level: 0 | 1 | 2;
}

// 1.1 / 2.3.1, never "1." and never "2026. The parties ...".
const NUM_MARKER = /^(\d{1,3}(?:\.\d{1,3}){1,3})\.?[ \t]+/;
const PAREN_MARKER = /^\(([A-Za-z]{1,6})\)[ \t]+/;

const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function toRoman(value: number): string {
  const table: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let left = value;
  let out = '';
  for (const [amount, token] of table) {
    while (left >= amount) {
      out += token;
      left -= amount;
    }
  }
  return out;
}

// A canonical roman numeral, so "mix" is a word and not 1009.
function romanValue(token: string): number | null {
  if (!/^[ivxlcdm]+$/.test(token)) return null;
  let total = 0;
  let previous = 0;
  for (let index = token.length - 1; index >= 0; index--) {
    const value = ROMAN_VALUES[token[index]];
    if (value < previous) total -= value;
    else {
      total += value;
      previous = value;
    }
  }
  if (total < 1 || total > 3999) return null;
  return toRoman(total) === token ? total : null;
}

function letterValue(token: string): number {
  return token.length === 1 ? token.charCodeAt(0) - 96 : 0;
}

// Splits a paragraph into lines and marks the ones that open with (a) / (i) / 1.1. Returns one
// entry per line; a line that is not a list item has level 0.
//
// Only letters i v x l c d m are ambiguous. A run of list items decides which reading holds:
// (a) then (i) opens a nested roman list (level 2), while a lone (i) is a roman list at level 1.
export function listLines(text: string, opts: { recital?: boolean } = {}): ListLine[] {
  const lines = text.split('\n');
  const out: ListLine[] = [];
  let run: { kind: ListKind; next: number; nested: boolean } | null = null;

  for (const line of lines) {
    if (NUM_MARKER.test(line)) {
      out.push({ text: line, kind: 'number', level: 1 });
      run = { kind: 'number', next: 0, nested: false };
      continue;
    }

    const paren = PAREN_MARKER.exec(line);
    if (!paren) {
      out.push({ text: line, kind: null, level: 0 });
      continue;
    }

    const token = paren[1];
    // Body markers are lower case; recitals use (A)/(B).
    if (/[A-Z]/.test(token) && !opts.recital) {
      out.push({ text: line, kind: null, level: 0 });
      continue;
    }

    const lower = token.toLowerCase();
    const single = lower.length === 1;
    const roman = romanValue(lower);
    let kind: ListKind;
    let nested = false;

    if (run?.kind === 'roman' && roman !== null && roman === run.next) {
      kind = 'roman';
      nested = run.nested;
      run = { kind: 'roman', next: roman + 1, nested };
    } else if (run?.kind === 'letter' && single && letterValue(lower) === run.next) {
      kind = 'letter';
      run = { kind: 'letter', next: run.next + 1, nested: false };
    } else if (run?.kind === 'letter' && roman === 1) {
      kind = 'roman';
      nested = true;
      run = { kind: 'roman', next: 2, nested: true };
    } else if (run?.kind === 'roman' && single && letterValue(lower) === 1) {
      kind = 'letter';
      run = { kind: 'letter', next: 2, nested: false };
    } else if (single && lower === 'i') {
      kind = 'roman';
      run = { kind: 'roman', next: 2, nested: false };
    } else if (single) {
      kind = 'letter';
      run = { kind: 'letter', next: letterValue(lower) + 1, nested: false };
    } else if (roman !== null) {
      kind = 'roman';
      run = { kind: 'roman', next: roman + 1, nested: false };
    } else {
      kind = 'letter';
      run = { kind: 'letter', next: 0, nested: false };
    }

    out.push({ text: line, kind, level: kind === 'roman' && nested ? 2 : 1 });
  }

  return out;
}

export function draftFileName(
  draft: Pick<DraftRecord, 'title' | 'sourcePlan'>,
  now: Date = new Date(),
): string {
  const raw = draft.title.trim() || draft.sourcePlan?.docType?.trim() || 'Draft';
  const safe =
    raw
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Draft';
  return `${safe} ${now.toISOString().slice(0, 10)}.docx`;
}
