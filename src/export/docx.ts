import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
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
import type { Block } from './blocks';

// DOCX writer: renders the shared export blocks. No content is decided here, so the file matches
// the screen and the HTML export section for section.

const FONT = 'Calibri';
const BODY = 20; // half-points: 10pt
const SMALL = 18;
const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const;

const text = (value: string, opts: { bold?: boolean; muted?: boolean; size?: number } = {}) =>
  new TextRun({ text: value, bold: opts.bold, size: opts.size ?? BODY, color: opts.muted ? '555555' : undefined, font: FONT });

function paragraph(block: Extract<Block, { kind: 'paragraph' }>): Paragraph {
  return new Paragraph({ children: [text(block.text, { muted: block.muted })], spacing: { after: 120 } });
}

function bullet(item: string): Paragraph {
  return new Paragraph({ children: [text(item)], bullet: { level: 0 }, spacing: { after: 60 } });
}

const CELL_MARGIN = { top: 80, bottom: 80, left: 120, right: 120 };
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

function cell(value: string, opts: { bold?: boolean; narrow?: boolean } = {}): TableCell {
  const options: ITableCellOptions = {
    children: value.split('\n').map(
      (line) =>
        new Paragraph({
          children: [text(line, { bold: opts.bold, size: SMALL })],
          spacing: { after: 40 },
        }),
    ),
    margins: CELL_MARGIN,
    borders: BORDERS,
    width: opts.narrow ? { size: 18, type: WidthType.PERCENTAGE } : undefined,
  };
  return new TableCell(options);
}

function table(block: Extract<Block, { kind: 'table' }>): Table {
  const rows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: block.columns.map((c) => cell(c, { bold: true, narrow: block.columns.length === 2 })),
    }),
    ...block.rows.map(
      (r) => new TableRow({ children: r.map((value, i) => cell(value, { narrow: block.columns.length === 2 && i === 0 })) }),
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
          text('AI-assisted, requires lawyer review', { muted: true, size: SMALL }),
          new TextRun({ text: '\t\t', size: SMALL }),
          new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: SMALL, color: '555555', font: FONT }),
        ],
      }),
    ],
  });
}

export function blocksToDocxChildren(blocks: Block[]): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'title':
        children.push(new Paragraph({ text: block.text, heading: HeadingLevel.TITLE, spacing: { after: 120 } }));
        break;
      case 'meta':
        for (const row of block.rows) {
          children.push(
            new Paragraph({
              children: [text(`${row.label}: `, { bold: true }), text(row.value)],
              spacing: { after: 40 },
            }),
          );
        }
        break;
      case 'toc':
        for (const entry of block.entries) {
          children.push(new Paragraph({ children: [text(`${entry.number}. ${entry.title}`)], spacing: { after: 40 } }));
        }
        break;
      case 'heading':
        children.push(
          new Paragraph({
            text: block.text,
            heading: HEADING_LEVELS[block.level],
            // Keep a heading with the clause table or paragraph that follows it.
            keepNext: true,
            keepLines: true,
            spacing: { before: block.level === 2 ? 320 : 200, after: 120 },
          }),
        );
        break;
      case 'paragraph':
        children.push(paragraph(block));
        break;
      case 'bullets':
        for (const item of block.items) children.push(bullet(item));
        break;
      case 'table':
        children.push(table(block));
        children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
        break;
      case 'footer':
        // The footer text is placed in the page footer; nothing is added to the body for it.
        break;
    }
  }
  return children;
}

export async function buildDocx(blocks: Block[]): Promise<Blob> {
  const doc = new Document({
    creator: 'Deep Analysis Report',
    title: 'Deep Analysis Report',
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
        children: blocksToDocxChildren(blocks),
      },
    ],
  });
  return Packer.toBlob(doc);
}
