import { jsPDF } from 'jspdf';
import { fontCoverage, type FontCoverage } from './cmap';
import type { DocBlock, ListItem } from './blocks';
import { ConversionError, type FontProvider, type FontScript } from './types';

// A small deterministic A4 layout: headings, wrapped paragraphs, lists and simple tables.
// Text is drawn with an embedded Noto Sans font (Latin) and Noto Sans Devanagari for
// Devanagari runs. Devanagari is kept in logical order so pdf.js extracts the exact
// original string; a visible warning notes that complex-script shaping is not applied.

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const BOTTOM = PAGE_HEIGHT - MARGIN_BOTTOM;

const BODY_SIZE = 11;
const BODY_LINE = 15.5;
const PARAGRAPH_GAP = 6;

const TABLE_SIZE = 9.5;
const TABLE_LINE = 13;
const TABLE_PAD = 4;

const LATIN_FILE = 'NotoSans-Regular.ttf';
const LATIN_FONT = 'NotoSans';
const DEVA_FILE = 'NotoSansDevanagari-Regular.ttf';
const DEVA_FONT = 'NotoSansDevanagari';

const FIXED_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

const DEVANAGARI_RANGE = /[\u0900-\u097f\u1cd0-\u1cff\uA8E0-\uA8FF]/u;

const SUBSTITUTES = new Map<number, string>([
  [0x25cf, '*'],
  [0x25cb, '*'],
  [0x25a0, '*'],
  [0x25a1, '*'],
  [0x25aa, '*'],
  [0x25ab, '*'],
  [0x2713, 'v'],
  [0x2714, 'v'],
  [0x2717, 'x'],
  [0x2718, 'x'],
  [0x2192, '->'],
  [0x2190, '<-'],
  [0x2264, '<='],
  [0x2265, '>='],
  [0x2212, '-'],
  [0x00d7, 'x'],
  [0x00f7, '/'],
  [0x2010, '-'],
  [0x2011, '-'],
  [0x2012, '-'],
  [0x2015, '-'],
  [0x2026, '...'],
  [0x00ad, '-'],
  [0x200b, ''],
  [0x200c, ''],
  [0x200d, ''],
  [0xfeff, ''],
]);

const base64Cache = new WeakMap<Uint8Array, string>();

function toBase64(bytes: Uint8Array): string {
  const cached = base64Cache.get(bytes);
  if (cached !== undefined) return cached;
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  const value = btoa(binary);
  base64Cache.set(bytes, value);
  return value;
}

function isDevanagariCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0900 && cp <= 0x097f) ||
    (cp >= 0x1cd0 && cp <= 0x1cff) ||
    (cp >= 0xa8e0 && cp <= 0xa8ff)
  );
}

interface Replacement {
  cp: number;
  replacement: string;
  count: number;
}

function codePointLabel(cp: number): string {
  if (cp >= 0x20 && cp !== 0x7f) return `'${String.fromCodePoint(cp)}' (U+${cp.toString(16).toUpperCase()})`;
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

function replacementWarnings(replacements: Map<number, Replacement>): string[] {
  if (replacements.size === 0) return [];
  const entries = [...replacements.values()].sort((a, b) => a.cp - b.cp);
  const shown = entries.slice(0, 6).map((entry) => {
    const to = entry.replacement ? `'${entry.replacement}'` : 'removed';
    const count = entry.count > 1 ? ` x${entry.count}` : '';
    return `${codePointLabel(entry.cp)} -> ${to}${count}`;
  });
  const more = entries.length > 6 ? ` and ${entries.length - 6} more` : '';
  return [
    `Unsupported characters were replaced so no text is dropped: ${shown.join(', ')}${more}. ` +
      'The original file keeps the exact characters.',
  ];
}

function collectText(blocks: DocBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'heading' || block.type === 'paragraph') parts.push(block.text);
    else if (block.type === 'list') for (const item of block.items) parts.push(item.text);
    else if (block.type === 'table') for (const row of block.rows) parts.push(...row);
  }
  return parts.join('\n');
}

interface LayoutOptions {
  fonts: FontProvider;
  /** 32 hex characters used as the PDF file id (deterministic). */
  fileId: string;
}

export interface LayoutResult {
  pdf: Uint8Array;
  warnings: string[];
}

class PdfLayout {
  private readonly doc: jsPDF;
  private readonly latin: FontCoverage;
  private readonly devanagari: FontCoverage | null;
  private readonly replacements = new Map<number, Replacement>();
  private readonly widthCache = new Map<string, number>();
  private y = MARGIN_TOP;

  constructor(doc: jsPDF, latin: FontCoverage, devanagari: FontCoverage | null) {
    this.doc = doc;
    this.latin = latin;
    this.devanagari = devanagari;
  }

  get replacementMap(): Map<number, Replacement> {
    return this.replacements;
  }

  private fontName(script: FontScript): string {
    return script === 'devanagari' ? DEVA_FONT : LATIN_FONT;
  }

  private chooseScript(cp: number): FontScript | null {
    if (isDevanagariCodePoint(cp)) {
      if (this.devanagari?.has(cp)) return 'devanagari';
      if (this.latin.has(cp)) return 'latin';
      return null;
    }
    if (this.latin.has(cp)) return 'latin';
    if (this.devanagari?.has(cp)) return 'devanagari';
    return null;
  }

  sanitise(value: string): string {
    let out = '';
    for (const char of value) {
      const cp = char.codePointAt(0);
      if (cp === undefined) continue;
      if (cp === 0x0a) {
        out += '\n';
        continue;
      }
      if (cp === 0x09 || cp === 0x0d || cp === 0x00a0) {
        out += ' ';
        continue;
      }
      if (cp < 0x20 || cp === 0x7f) continue;

      if (this.chooseScript(cp)) {
        out += char;
        continue;
      }

      const replacement = SUBSTITUTES.get(cp) ?? '?';
      const existing = this.replacements.get(cp);
      if (existing) existing.count++;
      else this.replacements.set(cp, { cp, replacement, count: 1 });
      out += replacement;
    }
    return out;
  }

  private segments(text: string): { script: FontScript; text: string }[] {
    const out: { script: FontScript; text: string }[] = [];
    for (const char of text) {
      const cp = char.codePointAt(0);
      if (cp === undefined) continue;
      // Newlines are handled by wrapText; a stray one should not reach here.
      if (cp === 0x0a) continue;
      const script = this.chooseScript(cp) ?? 'latin';
      const last = out[out.length - 1];
      if (last && last.script === script) last.text += char;
      else out.push({ script, text: char });
    }
    return out;
  }

  measure(text: string, size: number): number {
    const key = `${size}\u0000${text}`;
    const cached = this.widthCache.get(key);
    if (cached !== undefined) return cached;
    this.doc.setFontSize(size);
    let width = 0;
    for (const segment of this.segments(text)) {
      this.doc.setFont(this.fontName(segment.script), 'normal');
      width += this.doc.getTextWidth(segment.text);
    }
    this.widthCache.set(key, width);
    return width;
  }

  private draw(text: string, x: number, baseline: number, size: number): void {
    this.doc.setFontSize(size);
    let cursor = x;
    for (const segment of this.segments(text)) {
      this.doc.setFont(this.fontName(segment.script), 'normal');
      if (segment.text) this.doc.text(segment.text, cursor, baseline, { baseline: 'alphabetic' });
      cursor += this.doc.getTextWidth(segment.text);
    }
  }

  private newPage(): void {
    this.doc.addPage();
    this.y = MARGIN_TOP;
  }

  private ensure(height: number): void {
    if (this.y + height > BOTTOM) this.newPage();
  }

  wrap(text: string, maxWidth: number, size: number): string[] {
    const lines: string[] = [];
    for (const rawLine of text.split('\n')) {
      const words = rawLine.split(' ').filter((word) => word.length > 0);
      if (words.length === 0) {
        lines.push('');
        continue;
      }
      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (this.measure(candidate, size) <= maxWidth) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        if (this.measure(word, size) <= maxWidth) {
          line = word;
          continue;
        }
        let rest = word;
        line = '';
        while (rest && this.measure(rest, size) > maxWidth) {
          let low = 1;
          let high = rest.length;
          let best = 1;
          while (low <= high) {
            const mid = (low + high) >> 1;
            if (this.measure(rest.slice(0, mid), size) <= maxWidth) {
              best = mid;
              low = mid + 1;
            } else {
              high = mid - 1;
            }
          }
          lines.push(rest.slice(0, best));
          rest = rest.slice(best);
        }
        line = rest;
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  addHeading(text: string, level: number): void {
    const size = [0, 20, 16, 14, 12.5, 11.5, 11][Math.min(6, Math.max(1, level))];
    const line = size * 1.28;
    const lines = this.wrap(this.sanitise(text), CONTENT_WIDTH, size);
    if (this.y > MARGIN_TOP) this.y += 6;
    for (const value of lines) {
      this.ensure(line);
      if (value) this.draw(value, MARGIN_X, this.y + size * 0.82, size);
      this.y += line;
    }
    this.y += 4;
  }

  addParagraph(text: string, x = MARGIN_X, width = CONTENT_WIDTH): void {
    for (const line of this.wrap(this.sanitise(text), width, BODY_SIZE)) {
      this.ensure(BODY_LINE);
      if (line) this.draw(line, x, this.y + BODY_SIZE * 0.8, BODY_SIZE);
      this.y += BODY_LINE;
    }
    this.y += PARAGRAPH_GAP;
  }

  addList(items: ListItem[]): void {
    const counters: number[] = [];
    for (const item of items) {
      const level = Math.min(4, Math.max(0, item.level));
      const indent = 14 + level * 18;
      const markerWidth = 20;
      const contentX = MARGIN_X + indent + markerWidth;
      const width = Math.max(40, CONTENT_WIDTH - indent - markerWidth);
      const lines = this.wrap(this.sanitise(item.text), width, BODY_SIZE);
      const lineCount = Math.max(1, lines.length);

      let marker = '';
      if (item.ordered) {
        counters.length = level + 1;
        counters[level] = (counters[level] ?? 0) + 1;
        marker = `${counters[level]}.`;
      } else {
        counters.length = level + 1;
      }

      for (let i = 0; i < lineCount; i++) {
        this.ensure(BODY_LINE);
        const baseline = this.y + BODY_SIZE * 0.8;
        if (i === 0) {
          if (item.ordered) {
            this.doc.setFontSize(BODY_SIZE);
            this.doc.setFont(LATIN_FONT, 'normal');
            this.doc.text(marker, MARGIN_X + indent, baseline, { baseline: 'alphabetic' });
          } else {
            this.doc.setFillColor(40, 40, 40);
            this.doc.circle(MARGIN_X + indent + 4, baseline - 3.5, 1.5, 'F');
          }
        }
        if (lines[i]) this.draw(lines[i], contentX, baseline, BODY_SIZE);
        this.y += BODY_LINE;
      }
      this.y += 2;
    }
    this.y += PARAGRAPH_GAP;
  }

  addTable(rows: string[][]): void {
    if (rows.length === 0) return;
    const columns = Math.max(...rows.map((row) => row.length));
    if (columns === 0) return;

    // Sanitise each cell once: measuring and drawing must not count a replacement twice.
    const safeRows = rows.map((row) =>
      Array.from({ length: columns }, (_, c) => this.sanitise((row[c] ?? '').replace(/\n/g, ' '))),
    );

    const natural = new Array<number>(columns).fill(0);
    for (const row of safeRows) {
      for (let c = 0; c < columns; c++) {
        natural[c] = Math.max(natural[c], this.measure(row[c], TABLE_SIZE));
      }
    }
    let widths = natural.map((width) => Math.max(44, Math.min(width + TABLE_PAD * 2, CONTENT_WIDTH * 0.65)));
    let total = widths.reduce((sum, width) => sum + width, 0);
    if (total > CONTENT_WIDTH) {
      widths = widths.map((width) => (width * CONTENT_WIDTH) / total);
    } else if (total < CONTENT_WIDTH) {
      const extra = (CONTENT_WIDTH - total) / columns;
      widths = widths.map((width) => width + extra);
    }
    total = widths.reduce((sum, width) => sum + width, 0);
    if (total > CONTENT_WIDTH) widths[widths.length - 1] -= total - CONTENT_WIDTH;

    const header = safeRows.length > 1 ? safeRows[0] : null;
    const body = header ? safeRows.slice(1) : safeRows;
    const drawRow = (row: string[], isHeader: boolean): void => {
      const cellLines = new Array<string[]>(columns);
      for (let c = 0; c < columns; c++) {
        cellLines[c] = this.wrap(row[c], Math.max(20, widths[c] - TABLE_PAD * 2), TABLE_SIZE);
        if (cellLines[c].length === 0) cellLines[c] = [''];
      }
      const totalLines = Math.max(1, ...cellLines.map((lines) => lines.length));
      let start = 0;
      const repeatHeader = (): void => {
        if (header) drawRow(header, true);
      };

      while (start < totalLines) {
        if (this.y + TABLE_PAD * 2 + TABLE_LINE > BOTTOM) {
          this.newPage();
          if (!isHeader) repeatHeader();
        }
        const available = Math.max(
          1,
          Math.floor((BOTTOM - this.y - TABLE_PAD * 2) / TABLE_LINE),
        );
        const take = Math.max(1, Math.min(totalLines - start, available));
        const height = take * TABLE_LINE + TABLE_PAD * 2;

        this.doc.setDrawColor(150, 150, 150);
        this.doc.setLineWidth(0.4);
        let x = MARGIN_X;
        for (let c = 0; c < columns; c++) {
          this.doc.rect(x, this.y, widths[c], height);
          let baseline = this.y + TABLE_PAD + TABLE_SIZE * 0.8;
          for (let i = start; i < start + take; i++) {
            const line = cellLines[c][i] ?? '';
            if (line) this.draw(line, x + TABLE_PAD, baseline, TABLE_SIZE);
            // Keeps extracted table rows readable: a space item separates the columns.
            if (c < columns - 1) {
              this.doc.setFontSize(TABLE_SIZE);
              this.doc.setFont(LATIN_FONT, 'normal');
              this.doc.text(' ', x + widths[c] - TABLE_PAD, baseline, { baseline: 'alphabetic' });
            }
            baseline += TABLE_LINE;
          }
          x += widths[c];
        }
        this.y += height;
        start += take;
        if (start < totalLines) {
          this.newPage();
          if (!isHeader) repeatHeader();
        }
      }
    };

    if (header) drawRow(header, true);
    for (const row of body) drawRow(row, false);
    this.y += 4;
  }
}

async function loadFont(fonts: FontProvider, script: FontScript): Promise<Uint8Array> {
  try {
    return await fonts(script);
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    throw new ConversionError(
      'font',
      'The built-in fonts could not be loaded. Check the connection and try again.',
    );
  }
}

export async function renderBlocksToPdf(blocks: DocBlock[], options: LayoutOptions): Promise<LayoutResult> {
  const allText = collectText(blocks);
  const needsDevanagari = DEVANAGARI_RANGE.test(allText);
  const latinBytes = await loadFont(options.fonts, 'latin');
  const devanagariBytes = needsDevanagari ? await loadFont(options.fonts, 'devanagari') : null;
  const latin = fontCoverage(latinBytes);
  const devanagari = devanagariBytes ? fontCoverage(devanagariBytes) : null;

  const doc = new jsPDF({
    unit: 'pt',
    format: 'a4',
    orientation: 'portrait',
    compress: true,
    putOnlyUsedFonts: true,
  });
  doc.setFileId(/^[0-9a-f]{32}$/i.test(options.fileId) ? options.fileId : '0'.repeat(32));
  doc.setCreationDate(FIXED_DATE);
  doc.addFileToVFS(LATIN_FILE, toBase64(latinBytes));
  doc.addFont(LATIN_FILE, LATIN_FONT, 'normal');
  if (devanagariBytes) {
    doc.addFileToVFS(DEVA_FILE, toBase64(devanagariBytes));
    doc.addFont(DEVA_FILE, DEVA_FONT, 'normal');
  }

  const layout = new PdfLayout(doc, latin, devanagari);
  for (const block of blocks) {
    if (block.type === 'heading') layout.addHeading(block.text, block.level);
    else if (block.type === 'paragraph') layout.addParagraph(block.text);
    else if (block.type === 'list') layout.addList(block.items);
    else if (block.type === 'table') layout.addTable(block.rows);
  }

  const warnings: string[] = [];
  if (needsDevanagari) {
    warnings.push(
      'Devanagari text is included for search and analysis but is not shaped for print; ' +
        'the visual copy may differ from the original file.',
    );
  }
  warnings.push(...replacementWarnings(layout.replacementMap));

  return { pdf: new Uint8Array(doc.output('arraybuffer')), warnings };
}
