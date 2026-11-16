import type { DocBlock, ListItem } from './blocks';

// Mammoth emits a small, predictable subset of HTML: headings, paragraphs, lists,
// tables and inline emphasis. This parser covers that subset (unknown tags keep their
// text) so the converter does not need a general HTML parser dependency.

interface HtmlNode {
  tag: string;
  children: HtmlChild[];
}

type HtmlChild = HtmlNode | string;

interface ParseState {
  hasImages: boolean;
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'source', 'wbr']);
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'blockquote',
  'pre',
  'li',
  'tr',
  'td',
  'th',
  'ul',
  'ol',
  'table',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);
const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function normaliseText(value: string): string {
  return value
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function buildTree(html: string): HtmlNode {
  const root: HtmlNode = { tag: '#root', children: [] };
  const stack: HtmlNode[] = [root];
  const pattern = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html))) {
    const token = match[0];
    if (token.startsWith('<!--')) continue;

    if (token.startsWith('</')) {
      const name = token.slice(2, -1).trim().toLowerCase().split(/\s+/)[0];
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    if (token.startsWith('<')) {
      let inner = token.slice(1, -1).trim();
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1).trim();
      const name = (inner.match(/^([a-zA-Z][a-zA-Z0-9:-]*)/)?.[1] ?? '').toLowerCase();
      if (!name) continue;
      const node: HtmlNode = { tag: name, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing && !VOID_TAGS.has(name)) stack.push(node);
      continue;
    }

    stack[stack.length - 1].children.push(token);
  }

  return root;
}

function textOf(node: HtmlNode, state: ParseState, stop: Set<string> = new Set()): string {
  let out = '';
  for (const child of node.children) {
    if (typeof child === 'string') {
      out += decodeEntities(child);
      continue;
    }
    if (stop.has(child.tag)) continue;
    if (child.tag === 'br') {
      out += '\n';
      continue;
    }
    if (child.tag === 'img') {
      state.hasImages = true;
      continue;
    }
    if (child.tag === 'script' || child.tag === 'style') continue;
    out += textOf(child, state, stop);
    if (BLOCK_TAGS.has(child.tag) && out && !/\s$/.test(out)) out += ' ';
  }
  return out;
}

function collectList(node: HtmlNode, level: number, items: ListItem[], state: ParseState): void {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.tag === 'ul' || child.tag === 'ol') {
      collectList(child, level + 1, items, state);
      continue;
    }
    if (child.tag !== 'li') continue;

    const own = normaliseText(textOf(child, state, new Set(['ul', 'ol'])));
    if (own) items.push({ text: own, level, ordered: node.tag === 'ol' });
    for (const nested of child.children) {
      if (typeof nested !== 'string' && (nested.tag === 'ul' || nested.tag === 'ol')) {
        collectList(nested, level + 1, items, state);
      }
    }
  }
}

function collectRows(table: HtmlNode, state: ParseState): string[][] {
  const rows: string[][] = [];
  for (const child of table.children) {
    if (typeof child === 'string' || child.tag !== 'tr') continue;
    const cells: string[] = [];
    for (const cell of child.children) {
      if (typeof cell === 'string' || (cell.tag !== 'td' && cell.tag !== 'th')) continue;
      cells.push(normaliseText(textOf(cell, state)).replace(/\n/g, ' '));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function walk(node: HtmlNode, blocks: DocBlock[], state: ParseState): void {
  for (const child of node.children) {
    if (typeof child === 'string') {
      const text = normaliseText(decodeEntities(child));
      if (text) blocks.push({ type: 'paragraph', text });
      continue;
    }

    const headingLevel = HEADING_LEVEL[child.tag];
    if (headingLevel) {
      const text = normaliseText(textOf(child, state));
      if (text) blocks.push({ type: 'heading', level: headingLevel, text });
      continue;
    }

    switch (child.tag) {
      case 'p': {
        const text = normaliseText(textOf(child, state));
        if (text) blocks.push({ type: 'paragraph', text });
        break;
      }
      case 'ul':
      case 'ol': {
        const items: ListItem[] = [];
        collectList(child, 0, items, state);
        if (items.length > 0) blocks.push({ type: 'list', items });
        break;
      }
      case 'table': {
        const rows = collectRows(child, state);
        if (rows.length > 0) blocks.push({ type: 'table', rows });
        break;
      }
      case 'br':
      case 'hr':
        break;
      case 'img':
        state.hasImages = true;
        break;
      default:
        walk(child, blocks, state);
        break;
    }
  }
}

export interface HtmlBlocks {
  blocks: DocBlock[];
  hasImages: boolean;
}

export function htmlToBlocks(html: string): HtmlBlocks {
  const state: ParseState = { hasImages: false };
  const tree = buildTree(html);
  const blocks: DocBlock[] = [];
  walk(tree, blocks, state);
  return { blocks, hasImages: state.hasImages };
}
