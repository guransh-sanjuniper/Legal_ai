import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../../ingest/hash';
import { assessNativeText } from '../../../ingest/quality';
import { itemsToText } from '../../../ingest/textItems';
import { convertToPdf } from './convert';
import { ConversionError, type FontProvider } from './types';

const latin = new Uint8Array(readFileSync(new URL('./fonts/NotoSans-Regular.ttf', import.meta.url)));
const devanagari = new Uint8Array(
  readFileSync(new URL('./fonts/NotoSansDevanagari-Regular.ttf', import.meta.url)),
);
const fonts: FontProvider = async (script) => (script === 'devanagari' ? devanagari : latin);

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

interface Extracted {
  pageCount: number;
  pages: string[];
  imageCounts: number[];
}

async function extractText(pdf: Uint8Array): Promise<Extracted> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;
  const pages: string[] = [];
  const imageCounts: number[] = [];
  const imageOps = new Set<number>([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintImageXObjectRepeat,
    pdfjs.OPS.paintInlineImageXObjectGroup,
  ]);
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    const items = content.items.filter((item: any) => typeof item.str === 'string');
    pages.push(itemsToText(items));
    const ops = await page.getOperatorList();
    imageCounts.push(ops.fnArray.filter((fn: number) => imageOps.has(fn)).length);
    page.cleanup();
  }
  return { pageCount: doc.numPages, pages, imageCounts };
}

async function digest(pdf: Uint8Array): Promise<string> {
  return sha256Bytes(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer);
}

describe('convertToPdf', () => {
  it('converts a DOCX to a PDF with extractable text, headings, lists, tables and Unicode', async () => {
    const result = await convertToPdf(
      {
        name: 'sample.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: fixture('sample.docx'),
      },
      { fonts },
    );
    expect(result.kind).toBe('docx');
    const extracted = await extractText(result.pdf);
    const text = extracted.pages.join('\n');

    expect(text).toContain('Lease Agreement');
    expect(text).toContain('₹1,00,000');
    expect(text).toContain('“Security Deposit”');
    expect(text).toContain('First bullet');
    expect(text).toContain('Second bullet with किराया अनुबंध');
    expect(text).toMatch(/Item\s+Amount/);
    expect(text).toMatch(/Deposit\s+₹1,00,000/);
    expect(text).not.toContain('\u0000');
    expect(text).not.toContain('\uFFFD');

    // The fixture has a literal ●. Neither built-in font has that glyph, so it must be
    // replaced visibly and warned about, never silently dropped.
    expect(result.warnings.join(' ')).toContain('●');
    expect(result.warnings.join(' ')).toContain('replaced');
    expect(result.warnings.join(' ')).toContain('Devanagari');

    // The text layer is real: the existing quality check treats the page as native
    // text, so no OCR is triggered.
    for (let i = 0; i < extracted.pages.length; i++) {
      expect(assessNativeText(extracted.pages[i], extracted.imageCounts[i]).verdict).toBe('native');
    }
  });

  it('produces identical bytes for the same DOCX', async () => {
    const input = {
      name: 'sample.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: fixture('sample.docx'),
    };
    const first = await convertToPdf(input, { fonts });
    const second = await convertToPdf(input, { fonts });
    expect(await digest(first.pdf)).toBe(await digest(second.pdf));
  });

  it('converts a text file and keeps its lines and Unicode', async () => {
    const result = await convertToPdf(
      { name: 'sample.txt', type: 'text/plain', bytes: fixture('sample.txt') },
      { fonts },
    );
    const extracted = await extractText(result.pdf);
    const text = extracted.pages.join('\n');
    expect(text).toContain('NOTICE OF RENT REVIEW');
    expect(text).toContain('₹25,000');
    expect(text).toContain('किराया अनुबंध की प्रति संलग्न है.');
    expect(text).not.toContain('\u0000');
  });

  it('converts Markdown headings, lists and tables', async () => {
    const result = await convertToPdf(
      { name: 'sample.md', type: 'text/markdown', bytes: fixture('sample.md') },
      { fonts },
    );
    const extracted = await extractText(result.pdf);
    const text = extracted.pages.join('\n');
    expect(text).toContain('Lease Summary');
    expect(text).toContain('security deposit');
    expect(text).toContain('First point');
    expect(text).toContain('Deposit');
    expect(text).toContain('₹1,00,000');
    expect(text).toContain('Notes');
    expect(text).toContain('Rent is due monthly.');
  });

  it('embeds an image as one page, leaving OCR to the existing pipeline', async () => {
    const input = { name: 'pixel.png', type: 'image/png', bytes: fixture('pixel.png') };
    const first = await convertToPdf(input, { fonts });
    const second = await convertToPdf(input, { fonts });
    expect(first.kind).toBe('image');
    expect(await digest(first.pdf)).toBe(await digest(second.pdf));

    const extracted = await extractText(first.pdf);
    expect(extracted.pageCount).toBe(1);
    expect(extracted.imageCounts[0]).toBeGreaterThan(0);
    expect(extracted.pages[0].trim()).toBe('');
    expect(assessNativeText(extracted.pages[0], extracted.imageCounts[0]).verdict).toBe('needs_ocr');
  });

  it('embeds a JPEG as one page deterministically', async () => {
    const input = { name: 'pixel.jpg', type: 'image/jpeg', bytes: fixture('pixel.jpg') };
    const first = await convertToPdf(input, { fonts });
    const second = await convertToPdf(input, { fonts });
    expect(first.kind).toBe('image');
    expect(await digest(first.pdf)).toBe(await digest(second.pdf));

    const extracted = await extractText(first.pdf);
    expect(extracted.pageCount).toBe(1);
    expect(extracted.imageCounts[0]).toBeGreaterThan(0);
    expect(extracted.pages[0].trim()).toBe('');
  });

  it('fails a corrupt DOCX with a plain reason instead of throwing an internal error', async () => {
    const bytes = new TextEncoder().encode('this is not a zip file');
    await expect(
      convertToPdf({ name: 'broken.docx', type: '', bytes }, { fonts }),
    ).rejects.toMatchObject({
      name: 'ConversionError',
      code: 'corrupt',
    });
    await expect(convertToPdf({ name: 'broken.docx', type: '', bytes }, { fonts })).rejects.toThrow(
      'could not be read',
    );
  });

  it('rejects an unsupported Word 97-2003 file with the plain message', async () => {
    const error = await convertToPdf(
      { name: 'old.doc', type: 'application/msword', bytes: new Uint8Array([1, 2, 3]) },
      { fonts },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConversionError);
    expect(error.code).toBe('unsupported');
    expect(error.message).toBe(
      "Word 97-2003 files aren't supported. Save as .docx or PDF and upload again.",
    );
  });

  it('passes a PDF through unchanged', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const result = await convertToPdf({ name: 'plain.pdf', type: 'application/pdf', bytes }, { fonts });
    expect(result.kind).toBe('pdf');
    expect(result.pdf).toBe(bytes);
    expect(result.warnings).toEqual([]);
  });

  it('fails an empty text file with a plain reason', async () => {
    const error = await convertToPdf(
      { name: 'empty.txt', type: 'text/plain', bytes: new TextEncoder().encode('  \n\n ') },
      { fonts },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConversionError);
    expect(error.code).toBe('empty');
  });
});
