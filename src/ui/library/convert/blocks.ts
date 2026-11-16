// The intermediate document model shared by the DOCX, Markdown and text converters.
// The layout engine is the only consumer; nothing here touches the harness pipeline.

export interface ListItem {
  text: string;
  level: number;
  ordered: boolean;
}

export type DocBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: ListItem[] }
  | { type: 'table'; rows: string[][] };

export function blocksHaveText(blocks: DocBlock[]): boolean {
  for (const block of blocks) {
    if (block.type === 'heading' || block.type === 'paragraph') {
      if (block.text.trim()) return true;
    } else if (block.type === 'list') {
      if (block.items.some((item) => item.text.trim())) return true;
    } else if (block.type === 'table') {
      if (block.rows.some((row) => row.some((cell) => cell.trim()))) return true;
    }
  }
  return false;
}
