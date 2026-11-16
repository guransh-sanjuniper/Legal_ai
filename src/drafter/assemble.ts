import { numbering } from './outline';
import { itemFingerprint } from './write';
import type { DraftRecord, OutlineItem } from './types';

// D6: turn the outline and the written clauses into one ordered block list, plus the counts the
// review screen and the export gate need. Pure: no UI, no model, no storage.

export type DraftBlock =
  | { kind: 'title'; text: string }
  | { kind: 'subtitle'; text: string }
  | { kind: 'heading'; level: 1 | 2; number: string; text: string }
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
    blocks.push({ kind: 'heading', level: item.level, number: labels[index] ?? '', text: item.title });

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
