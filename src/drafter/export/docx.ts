import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  HighlightColor,
  LeaderType,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableLayoutType,
  TableOfContents,
  TableRow,
  TabStopType,
  TextRun,
  WidthType,
  type ITableCellOptions,
} from 'docx';
import { headingLabel, headingTitle, listLines, type DraftBlock } from '../assemble';
import type { OutlineKind } from '../types';

// Drafter DOCX writer (D6.1): renders the Drafter's own block list as a neutral legal document.
// Serif, black text, code-generated heading numbers. Everything special (cover, contents,
// schedule pages, signature table) switches on only when the outline already has the structure:
// 15 or more level-1 sections, a schedule/signature/preamble kind, a "between ... and ..." line.

const FONT = 'Times New Roman';
const BODY = 22; // half-points: 11pt
const SMALL = 18;
const TITLE = 36;
const COVER_TITLE = 64;
const COVER_LINE = 22;
const HEADING_1 = 28;
const HEADING_2 = 24;

const MARGIN = 720;
const PAGE_WIDTH = 11906; // A4, the writer's default page
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
} as const;

// Level-1 headings get a cover and a contents page from this count up (level-2 items never count).
export const COVER_SECTION_THRESHOLD = 15;

const PLACEHOLDER = /\[●[^\]]*\]/g;
// (the "Term") or "Term" means / "Term" shall mean.
const DEFINED_TERM =
  /\(\s*(?:the\s+)?["“][^"“”\n]{1,80}["”]\s*\)|["“][^"“”\n]{1,80}["”]\s+(?:means|shall\s+mean)\b/gi;
const QUOTED = /["“][^"“”\n]{1,80}["”]/;

interface Piece {
  text: string;
  bold: boolean;
  highlight: boolean;
}

// Splits text into pieces that carry only formatting. Joining the pieces always gives the input
// back, so nothing is added, dropped or reworded.
function marked(text: string, definedTerms: boolean): Piece[] {
  const marks: Array<{ start: number; end: number; bold: boolean; highlight: boolean }> = [];

  for (const match of text.matchAll(PLACEHOLDER)) {
    const at = match.index ?? 0;
    marks.push({ start: at, end: at + match[0].length, bold: false, highlight: true });
  }
  if (definedTerms) {
    for (const match of text.matchAll(DEFINED_TERM)) {
      const quote = QUOTED.exec(match[0]);
      if (!quote) continue;
      const start = (match.index ?? 0) + (quote.index ?? 0);
      marks.push({ start, end: start + quote[0].length, bold: true, highlight: false });
    }
  }

  if (marks.length === 0) return [{ text, bold: false, highlight: false }];

  const cuts = new Set<number>([0, text.length]);
  for (const mark of marks) {
    cuts.add(mark.start);
    cuts.add(mark.end);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let index = 0; index < sorted.length - 1; index++) {
    const start = sorted[index];
    const end = sorted[index + 1];
    if (start >= end) continue;
    const inside = marks.filter((mark) => mark.start <= start && mark.end >= end);
    const bold = inside.some((mark) => mark.bold);
    const highlight = inside.some((mark) => mark.highlight);
    const previous = pieces[pieces.length - 1];
    if (previous && previous.bold === bold && previous.highlight === highlight) {
      previous.text += text.slice(start, end);
    } else {
      pieces.push({ text: text.slice(start, end), bold, highlight });
    }
  }
  return pieces;
}

interface RunOptions {
  bold?: boolean;
  muted?: boolean;
  size?: number;
  // Off for headings and table cells: only body paragraphs bold defined terms.
  definedTerms?: boolean;
}

function runs(value: string, opts: RunOptions = {}): TextRun[] {
  // definedTerms only turns the bold scan off; [●] stays highlighted everywhere.
  const pieces = marked(value, opts.definedTerms !== false);
  const out: TextRun[] = [];
  for (const piece of pieces) {
    // A newline in a run is a real Word break, not a literal character inside the text.
    piece.text.split('\n').forEach((line, index) => {
      if (line === '' && index === 0) return;
      out.push(
        new TextRun({
          text: line,
          break: index > 0 ? 1 : undefined,
          bold: opts.bold || piece.bold || undefined,
          size: opts.size ?? BODY,
          font: FONT,
          color: opts.muted ? '555555' : undefined,
          highlight: piece.highlight ? HighlightColor.YELLOW : undefined,
        }),
      );
    });
  }
  return out;
}

function paragraph(text: string, opts: { level?: 0 | 1 | 2 } = {}): Paragraph {
  const level = opts.level ?? 0;
  return new Paragraph({
    children: runs(text),
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 120, line: 276 },
    widowControl: true,
    indent: level > 0 ? { left: 720 * level, hanging: 360 } : undefined,
  });
}

// A paragraph block may hold several lines. Only when one of them opens with (a)/(i)/1.1 is the
// block laid out line by line, so ordinary multi-line paragraphs keep their shape.
function bodyParagraphs(text: string, sectionKind?: OutlineKind): Paragraph[] {
  const lines = listLines(text, { recital: sectionKind === 'recital' });
  if (!lines.some((line) => line.level > 0)) return [paragraph(text)];
  return lines.map((line) => paragraph(line.text, { level: line.level }));
}

const CELL_MARGIN = { top: 80, bottom: 80, left: 120, right: 120 };
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
const NO_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'auto' },
  left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
  right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
};

function cell(value: string, opts: { bold?: boolean; header?: boolean } = {}): TableCell {
  const options: ITableCellOptions = {
    children: value.split('\n').map(
      (line) =>
        new Paragraph({
          children: runs(line, { bold: opts.bold, size: SMALL, definedTerms: false }),
          spacing: { after: 40 },
        }),
    ),
    margins: CELL_MARGIN,
    borders: BORDERS,
    shading: opts.header ? { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } : undefined,
  };
  return new TableCell(options);
}

function table(block: Extract<DraftBlock, { kind: 'table' }>): Table {
  const rows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: block.columns.map((column) => cell(column, { bold: true, header: true })),
    }),
    ...block.rows.map(
      (row) => new TableRow({ children: block.columns.map((_, index) => cell(row[index] ?? '')) }),
    ),
  ];
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
  });
}

function heading(block: Extract<DraftBlock, { kind: 'heading' }>, opts: { pageBreak?: boolean } = {}): Paragraph {
  const title = headingTitle(block);
  const size = block.level === 1 ? HEADING_1 : HEADING_2;
  // "Schedule 1.1" is too wide for the number column, so it keeps today's number + space form.
  const hang = block.number !== '' && block.number.length <= 10;
  const indent = block.level === 1 ? 720 : 1440;
  const text = (value: string) => new TextRun({ text: value, bold: true, size, font: FONT, color: '000000' });
  const children = hang
    ? [text(block.number), new TextRun({ children: [new Tab()] }), ...(title ? [text(title)] : [])]
    : [text(headingLabel(block))];

  return new Paragraph({
    heading: HEADING_LEVELS[block.level],
    keepNext: true,
    keepLines: true,
    widowControl: true,
    pageBreakBefore: opts.pageBreak || block.sectionKind === 'schedule',
    alignment: block.sectionKind === 'preamble' ? AlignmentType.CENTER : undefined,
    spacing: { before: block.level === 1 ? 320 : 200, after: 120 },
    indent: hang ? { left: indent, hanging: indent } : undefined,
    tabStops: hang ? [{ type: TabStopType.LEFT, position: indent }] : undefined,
    children,
  });
}

function footer(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }],
        children: [
          new TextRun({ text: 'AI-assisted, requires lawyer review', size: SMALL, color: '555555', font: FONT }),
          new TextRun({ children: [new Tab()] }),
          new TextRun({
            children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES],
            size: SMALL,
            color: '555555',
            font: FONT,
          }),
        ],
      }),
    ],
  });
}

function header(title: string): Header {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: title, size: 16, color: '555555', font: FONT })],
      }),
    ],
  });
}

// ---------- Cover page ----------

const PARTIES = /\bbetween\s+([^.;:\n]{2,120}?)\s+and\s+([^.;:\n]{2,160}?)(?=[.;\n]|$)/i;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatLongDate(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function preambleText(blocks: DraftBlock[]): string {
  const start = blocks.findIndex((block) => block.kind === 'heading' && block.sectionKind === 'preamble');
  if (start === -1) return '';
  const parts: string[] = [];
  for (let index = start + 1; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.kind === 'heading') break;
    if (block.kind === 'paragraph') parts.push(block.text);
  }
  return parts.join(' ');
}

// The cover's parties line, taken word for word from the preamble. Omitted when the preamble has
// no recognisable "between ... and ..." or when either side is not a name.
export function partiesLine(blocks: DraftBlock[]): string {
  const text = preambleText(blocks);
  if (!text) return '';
  const match = PARTIES.exec(text);
  if (!match) return '';
  const first = match[1].trim();
  const second = match[2].trim();
  const named = (value: string) => value.length >= 2 && /[A-Z]/.test(value);
  if (!named(first) || !named(second)) return '';
  return match[0].replace(/\s+/g, ' ').trim();
}

function coverChildren(blocks: DraftBlock[], now: Date): Paragraph[] {
  const title = blocks.find((block) => block.kind === 'title')?.text ?? 'Draft';
  const subtitle = blocks.find((block) => block.kind === 'subtitle')?.text ?? '';
  const parties = partiesLine(blocks);
  const centred = (
    text: string,
    size: number,
    spacing: { before?: number; after?: number },
    bold = false,
  ) =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing,
      children: [new TextRun({ text, bold: bold || undefined, size, font: FONT, color: '000000' })],
    });

  const out: Paragraph[] = [centred(title, COVER_TITLE, { before: 3600, after: 240 }, true)];
  if (subtitle) out.push(centred(subtitle, 26, { after: 1200 }));
  if (parties) out.push(centred(parties, COVER_LINE, { after: 240 }));
  out.push(centred(formatLongDate(now), COVER_LINE, { before: 240 }));
  return out;
}

function contentsHeading(): Paragraph {
  // Deliberately not a Heading style: the contents must not list itself.
  return new Paragraph({
    pageBreakBefore: true,
    keepNext: true,
    spacing: { after: 240 },
    children: [new TextRun({ text: 'Contents', bold: true, size: HEADING_1, font: FONT, color: '000000' })],
  });
}

function contentsField(): TableOfContents {
  return new TableOfContents('Contents', {
    hyperlink: true,
    headingStyleRange: '1-2',
    tabLeader: LeaderType.DOT,
    beginDirty: true,
  });
}

// ---------- Signature block ----------

const SIGN_ROLE = /^([A-Za-z][^:\n]{1,59}):[ \t]*(.*?)[ \t]*(_{3,})[ \t]*$/;
const WITNESS = /^witness(?:es)?\b/i;

interface SignatureRole {
  role: string;
  name: string;
  line: string;
}

function signatureCell(entry: SignatureRole): TableCell {
  return new TableCell({
    borders: NO_BORDERS,
    margins: { top: 120, bottom: 120, left: 0, right: 240 },
    children: [
      new Paragraph({
        children: runs(`${entry.role}:`, { bold: true, size: SMALL, definedTerms: false }),
        spacing: { after: 40 },
      }),
      ...(entry.name
        ? [
            new Paragraph({
              children: runs(entry.name, { size: SMALL, definedTerms: false }),
              spacing: { after: 40 },
            }),
          ]
        : []),
      new Paragraph({
        spacing: { before: 240, after: 40 },
        children: runs(entry.line, { size: SMALL, definedTerms: false }),
      }),
      new Paragraph({ children: runs('Date: ____', { size: SMALL, definedTerms: false }) }),
    ],
  });
}

function signatureRows(entries: SignatureRole[]): TableRow[] {
  const rows: TableRow[] = [];
  for (let index = 0; index < entries.length; index += 3) {
    rows.push(new TableRow({ children: entries.slice(index, index + 3).map(signatureCell) }));
  }
  return rows;
}

function borderlessTable(rows: TableRow[]): Table {
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: { ...NO_BORDERS, insideHorizontal: NO_BORDERS.top, insideVertical: NO_BORDERS.left },
  });
}

// One column per party, three to a row. Text that is not a role line stays a paragraph in place;
// witness lines move to a row of their own below. Nothing is dropped either way.
function signatureChildren(texts: string[]): (Paragraph | Table)[] {
  const lines: string[] = [];
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) lines.push(trimmed);
    }
  }

  const roles = lines
    .map((line) => SIGN_ROLE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  if (roles.length < 2) return texts.map((text) => paragraph(text));

  const witnesses: string[] = [];
  const out: (Paragraph | Table)[] = [];
  let pending: SignatureRole[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    out.push(borderlessTable(signatureRows(pending)));
    pending = [];
  };

  for (const line of lines) {
    if (WITNESS.test(line)) {
      witnesses.push(line);
      continue;
    }
    const match = SIGN_ROLE.exec(line);
    if (match) {
      pending.push({ role: match[1].trim(), name: match[2].trim(), line: match[3] });
      continue;
    }
    flush();
    out.push(paragraph(line));
  }
  flush();

  if (witnesses.length > 0) {
    const rows: TableRow[] = [];
    for (let index = 0; index < witnesses.length; index += 3) {
      rows.push(
        new TableRow({
          children: witnesses.slice(index, index + 3).map(
            (line) =>
              new TableCell({
                borders: NO_BORDERS,
                margins: { top: 120, bottom: 120, left: 0, right: 240 },
                children: [
                  new Paragraph({
                    spacing: { before: 240 },
                    children: runs(line, { size: SMALL, definedTerms: false }),
                  }),
                ],
              }),
          ),
        }),
      );
    }
    out.push(borderlessTable(rows));
  }

  return out;
}

// ---------- Blocks ----------

// The kind of the section each block belongs to, so paragraphs know whether they sit under a
// recital (upper-case (A)/(B) markers) without adding a field to every paragraph block.
function sectionKinds(blocks: DraftBlock[]): (OutlineKind | undefined)[] {
  let current: OutlineKind | undefined;
  return blocks.map((block) => {
    if (block.kind === 'heading') current = block.sectionKind;
    return current;
  });
}

function renderBlock(
  block: DraftBlock,
  opts: { pageBreak?: boolean; sectionKind?: OutlineKind },
): (Paragraph | Table)[] {
  switch (block.kind) {
    case 'title':
      return [
        new Paragraph({
          heading: HeadingLevel.TITLE,
          pageBreakBefore: opts.pageBreak,
          keepNext: true,
          spacing: { after: 120 },
          children: [new TextRun({ text: block.text, bold: true, size: TITLE, font: FONT, color: '000000' })],
        }),
      ];
    case 'subtitle':
      return [
        new Paragraph({
          children: runs(block.text, { muted: true, size: 24, definedTerms: false }),
          spacing: { after: 240 },
        }),
      ];
    case 'heading':
      return [heading(block, { pageBreak: opts.pageBreak })];
    case 'paragraph':
      return bodyParagraphs(block.text, opts.sectionKind);
    case 'table':
      return [table(block), new Paragraph({ text: '', spacing: { after: 120 } })];
  }
}

// A signature heading owns the paragraphs under it: they become one table, so the renderer
// consumes them together rather than one block at a time.
function renderFrom(
  blocks: DraftBlock[],
  kinds: (OutlineKind | undefined)[],
  index: number,
  opts: { pageBreak?: boolean },
): { children: (Paragraph | Table)[]; consumed: number } {
  const block = blocks[index];
  if (block.kind === 'heading' && block.sectionKind === 'signature') {
    const texts: string[] = [];
    let next = index + 1;
    for (;;) {
      const candidate = blocks[next];
      if (!candidate || candidate.kind !== 'paragraph') break;
      texts.push(candidate.text);
      next++;
    }
    if (texts.length > 0) {
      return { children: [heading(block, opts), ...signatureChildren(texts)], consumed: next - index };
    }
  }
  return { children: renderBlock(block, { ...opts, sectionKind: kinds[index] }), consumed: 1 };
}

export function blocksToDocxChildren(
  blocks: DraftBlock[],
  opts: { pageBreakBeforeFirst?: boolean } = {},
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  const kinds = sectionKinds(blocks);
  for (let index = 0; index < blocks.length; ) {
    const rendered = renderFrom(blocks, kinds, index, {
      pageBreak: index === 0 && opts.pageBreakBeforeFirst,
    });
    children.push(...rendered.children);
    index += rendered.consumed;
  }
  return children;
}

export async function buildDraftDocx(blocks: DraftBlock[], opts: { now?: Date } = {}): Promise<Blob> {
  const now = opts.now ?? new Date();
  const level1Sections = blocks.filter((block) => block.kind === 'heading' && block.level === 1).length;
  const hasCover = level1Sections >= COVER_SECTION_THRESHOLD;
  const title = blocks.find((block) => block.kind === 'title')?.text ?? '';

  // The cover carries the title, so the body starts at the first heading.
  const bodyBlocks = hasCover
    ? blocks.filter((block) => block.kind !== 'title' && block.kind !== 'subtitle')
    : blocks;

  const children: (Paragraph | Table)[] = [];
  if (hasCover) {
    children.push(...coverChildren(blocks, now));
    children.push(contentsHeading());
    // TableOfContents is a FileChild; the section's children type only lists Paragraph and Table.
    children.push(contentsField() as unknown as Paragraph);
  }

  let nextYield = 20;
  const bodyKinds = sectionKinds(bodyBlocks);
  for (let index = 0; index < bodyBlocks.length; ) {
    const rendered = renderFrom(bodyBlocks, bodyKinds, index, { pageBreak: hasCover && index === 0 });
    children.push(...rendered.children);
    index += rendered.consumed;
    // Yield every 20 blocks so a large document does not freeze the tab.
    if (index >= nextYield) {
      nextYield = index + 20;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  const doc = new Document({
    creator: 'Legal Workspace Drafter',
    title: 'Draft',
    description: 'AI-assisted, requires lawyer review',
    // Word refreshes the contents field (page numbers) when the file is opened.
    features: { updateFields: true },
    styles: {
      default: {
        document: { run: { font: FONT, size: BODY } },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } },
          // The cover page has no header or footer of its own.
          titlePage: hasCover ? true : undefined,
        },
        headers: hasCover
          ? { default: header(title), first: new Header({ children: [new Paragraph('')] }) }
          : { default: header(title) },
        footers: hasCover
          ? { default: footer(), first: new Footer({ children: [new Paragraph('')] }) }
          : { default: footer() },
        children,
      },
    ],
  });
  return Packer.toBlob(doc);
}
