import type { DocBlock, ListItem } from './blocks';

// A deliberately small Markdown reader for legal notes: headings, paragraphs, lists,
// pipe tables, fenced code and blockquotes. Inline markers are flattened to text; the
// PDF only needs readable content and an accurate text layer.

function inline(value: string): string {
  let text = value;
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1');
  text = text.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, '$1');
  text = text.replace(/<[^>]+>/g, '');
  return text.replace(/\s+/g, ' ').trim();
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => inline(cell.replace(/\\\|/g, '|')));
}

function isTableSeparator(line: string): boolean {
  if (!line.includes('|')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*```/;
const BLOCKQUOTE = /^\s*>\s?(.*)$/;
const THEMATIC_BREAK = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const SETEXT_UNDERLINE = /^\s*(=+|-+)\s*$/;

export function markdownToBlocks(markdown: string): DocBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocBlock[] = [];
  let paragraph: string[] = [];
  let list: ListItem[] = [];
  let code: string[] | null = null;

  const flushParagraph = () => {
    const text = inline(paragraph.join(' '));
    paragraph = [];
    if (text) blocks.push({ type: 'paragraph', text });
  };
  const flushList = () => {
    if (list.length > 0) blocks.push({ type: 'list', items: list });
    list = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (code !== null) {
      if (FENCE.test(line)) {
        const text = code.join('\n').trim();
        if (text) blocks.push({ type: 'paragraph', text });
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (FENCE.test(line)) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const tableHeader = line;
    if (tableHeader.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      flushList();
      const rows: string[][] = [splitRow(tableHeader)];
      i++;
      while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].includes('|')) {
        i++;
        rows.push(splitRow(lines[i]));
      }
      blocks.push({ type: 'table', rows });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      flushList();
      const text = inline(heading[2]);
      if (text) blocks.push({ type: 'heading', level: heading[1].length, text });
      continue;
    }

    const setext = line.match(SETEXT_UNDERLINE);
    if (setext && paragraph.length === 1) {
      const text = inline(paragraph[0]);
      paragraph = [];
      if (text) blocks.push({ type: 'heading', level: setext[1].startsWith('=') ? 1 : 2, text });
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }

    const quote = line.match(BLOCKQUOTE);
    if (quote) {
      flushList();
      paragraph.push(quote[1]);
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      flushParagraph();
      const level = Math.min(4, Math.floor(item[1].length / 2));
      const text = inline(item[3]);
      if (text) list.push({ text, level, ordered: /^\d/.test(item[2]) });
      continue;
    }

    // An indented continuation after a list item belongs to that item.
    if (list.length > 0 && paragraph.length === 0 && /^\s{2,}\S/.test(line)) {
      const last = list[list.length - 1];
      const extra = inline(line);
      if (extra) last.text = `${last.text} ${extra}`.trim();
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (code !== null) {
    const text = code.join('\n').trim();
    if (text) blocks.push({ type: 'paragraph', text });
  }
  flushParagraph();
  flushList();
  return blocks;
}
