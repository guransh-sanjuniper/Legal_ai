import type { DraftStatus } from './types';

// The title is optional in the form. When it is blank, the start of the instruction stands in
// for it so the drafts list never shows an empty row.
export const DERIVED_TITLE_CHARS = 60;

export function deriveTitle(instruction: string): string {
  const flat = instruction.replace(/\s+/g, ' ').trim();
  if (!flat) return 'Untitled draft';
  if (flat.length <= DERIVED_TITLE_CHARS) return flat;
  return `${flat.slice(0, DERIVED_TITLE_CHARS).trimEnd()}…`;
}

export function titleOrDerived(title: string, instruction: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat || deriveTitle(instruction);
}

export function draftStatusLabel(status: DraftStatus): string {
  switch (status) {
    case 'brief':
      return 'Brief';
    case 'planned':
      return 'Planned';
    case 'outlined':
      return 'Outline';
    case 'generating':
      return 'Generating';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
  }
}
