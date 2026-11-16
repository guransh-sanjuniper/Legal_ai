import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  HighlightColor,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  type ITableCellOptions,
} from 'docx';
import type { DraftBlock } from '../assemble';

// Drafter DOCX writer: renders the Drafter's own block list. Times-like legal style, headings
// and tables from code, [●] placeholders highlighted yellow, footer with the review notice.

const FONT = 'Times New Roman';
const BODY = 22; // half-points: 11pt
const SMALL = 18;
const TITLE = 36;
const HEADING_1 = 28;
const HEADING_2 = 24;

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
} as const;

const PLACEHOLDER = /(\[●[^\]]*\])/g;

function runs(value: string, opts: { bold?: boolean; muted?: boolean; size?: number } = {}): TextRun[] {
  return value
    .split(PLACEHOLDER)
    .filter((part) => part !== '')
    .map((part) =>
      part.startsWith('[●')
        ? new TextRun({
            text: part,
            bold: opts.bold,
            size: opts.size ?? BODY,
            font: FONT,
            highlight: HighlightColor.YELLOW,
          })
        : new TextRun({
            text: part,
            bold: opts.bold,
            size: opts.size ?? BODY,
            color: opts.muted ? '555555' : undefined,
            font: FONT,
          }),
    );
}

function paragraph(text: string): Paragraph {
  return new Paragraph({
    children: runs(text),
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 120 },
  });
}

const CELL_MARGIN = { top: 60, bottom: 60, left: 100, right: 100 };
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

function cell(value: string, opts: { bold?: boolean } = {}): TableCell {
  const options: ITableCellOptions = {
    children: value.split('\n').map(
      (line) =>
        new Paragraph({
          children: runs(line, { bold: opts.bold, size: SMALL }),
          spacing: { after: 40 },
        }),
    ),
    margins: CELL_MARGIN,
    borders: BORDERS,
  };
  return new TableCell(options);
}

function table(block: Extract<DraftBlock, { kind: 'table' }>): Table {
  const rows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: block.columns.map((column) => cell(column, { bold: true })),
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

function footer(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: 'AI-assisted, requires lawyer review', size: SMALL, color: '555555', font: FONT }),
          new TextRun({ text: '\t\t', size: SMALL }),
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

function heading(block: Extract<DraftBlock, { kind: 'heading' }>): Paragraph {
  const label = block.number ? `${block.number} ${block.text}` : block.text;
  return new Paragraph({
    heading: HEADING_LEVELS[block.level],
    keepNext: true,
    keepLines: true,
    spacing: { before: block.level === 1 ? 320 : 200, after: 120 },
    children: [
      new TextRun({
        text: label,
        bold: true,
        size: block.level === 1 ? HEADING_1 : HEADING_2,
        font: FONT,
        color: '000000',
      }),
    ],
  });
}

export function blocksToDocxChildren(blocks: DraftBlock[]): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'title':
        children.push(
          new Paragraph({
            heading: HeadingLevel.TITLE,
            spacing: { after: 120 },
            children: [new TextRun({ text: block.text, bold: true, size: TITLE, font: FONT, color: '000000' })],
          }),
        );
        break;
      case 'subtitle':
        children.push(
          new Paragraph({
            children: runs(block.text, { muted: true, size: 24 }),
            spacing: { after: 240 },
          }),
        );
        break;
      case 'heading':
        children.push(heading(block));
        break;
      case 'paragraph':
        children.push(paragraph(block.text));
        break;
      case 'table':
        children.push(table(block));
        children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
        break;
    }
  }
  return children;
}

export async function buildDraftDocx(blocks: DraftBlock[]): Promise<Blob> {
  const children: (Paragraph | Table)[] = [];
  for (let index = 0; index < blocks.length; index++) {
    children.push(...blocksToDocxChildren([blocks[index]]));
    // Yield every 20 blocks so a large document does not freeze the tab.
    if ((index + 1) % 20 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  const doc = new Document({
    creator: 'Legal Workspace Drafter',
    title: 'Draft',
    description: 'AI-assisted, requires lawyer review',
    styles: {
      default: {
        document: { run: { font: FONT, size: BODY } },
      },
    },
    sections: [
      {
        properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
        footers: { default: footer() },
        children,
      },
    ],
  });
  return Packer.toBlob(doc);
}
