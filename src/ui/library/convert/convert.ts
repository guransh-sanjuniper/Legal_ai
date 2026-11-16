import mammoth from 'mammoth';
import { jsPDF } from 'jspdf';
import { sha256Bytes } from '../../../ingest/hash';
import { blocksHaveText, type DocBlock } from './blocks';
import { htmlToBlocks } from './html';
import { markdownToBlocks } from './markdown';
import { renderBlocksToPdf } from './layout';
import { detectKind } from './detect';
import { ConversionError, type ConversionInput, type ConversionResult, type ConvertOptions } from './types';

// Converts a supported file to a plain PDF. The output goes through the existing
// import/preparation path unchanged: the pipeline only ever sees a PDF Blob.

interface MammothMessage {
  type: string;
  message: string;
}

interface MammothResult {
  value: string;
  messages: MammothMessage[];
}

interface MammothApi {
  convertToHtml(input: unknown, options?: unknown): Promise<MammothResult>;
  images: { imgElement(convert: (image: unknown) => { src: string }): unknown };
}

const mammothApi = mammoth as unknown as MammothApi;

const FIXED_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const IMAGE_MARGIN = 36;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function deterministicFileId(bytes: Uint8Array): Promise<string> {
  try {
    return (await sha256Bytes(toArrayBuffer(bytes))).slice(0, 32);
  } catch {
    return '0'.repeat(32);
  }
}

function malformedWord(): ConversionError {
  return new ConversionError(
    'corrupt',
    'This Word file could not be read. It may be corrupted or password-protected. ' +
      'Save it again as .docx or upload a PDF.',
  );
}

function relevantMammothWarnings(messages: MammothMessage[]): string[] {
  const warnings: string[] = [];
  for (const message of messages) {
    const text = message.message.trim();
    if (!text) continue;
    if (message.type === 'error') {
      warnings.push(text);
    } else if (/ignor|not supported|unsupported/i.test(text) && !/style/i.test(text)) {
      warnings.push(text);
    }
  }
  return [...new Set(warnings)].slice(0, 3);
}

async function docxToBlocks(bytes: Uint8Array): Promise<{ blocks: DocBlock[]; warnings: string[] }> {
  let hadImages = false;
  let result: MammothResult;
  try {
    result = await mammothApi.convertToHtml(
      { arrayBuffer: toArrayBuffer(bytes), buffer: bytes },
      {
        convertImage: mammothApi.images.imgElement(() => {
          hadImages = true;
          return { src: '' };
        }),
      },
    );
  } catch {
    throw malformedWord();
  }

  const parsed = htmlToBlocks(result.value);
  const warnings = relevantMammothWarnings(result.messages);
  if (hadImages || parsed.hasImages) {
    warnings.push('Pictures in the Word file are not included in the converted PDF.');
  }
  if (!blocksHaveText(parsed.blocks)) {
    throw new ConversionError(
      'empty',
      'This Word file has no text to convert. If it contains only pictures, save it as a PDF and upload that.',
    );
  }
  return { blocks: parsed.blocks, warnings };
}

function decodeText(bytes: Uint8Array): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let encoding = 'utf-8';
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    start = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    start = 2;
  }

  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(start));
  } catch {
    text = new TextDecoder(encoding).decode(bytes.subarray(start));
    warnings.push('The text file is not valid UTF-8; some characters may be wrong.');
  }
  if (text.includes('\uFFFD')) {
    text = text.replace(/\uFFFD/g, '?');
    if (warnings.length === 0) {
      warnings.push('Some characters in the text file could not be decoded and were replaced with ?.');
    }
  }
  return { text, warnings };
}

function textToBlocks(text: string): DocBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocBlock[] = [];
  for (const line of lines) {
    const value = line.trim();
    if (value) blocks.push({ type: 'paragraph', text: value });
  }
  return blocks;
}

function imageFormat(bytes: Uint8Array): 'PNG' | 'JPEG' | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'PNG';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'JPEG';
  }
  return null;
}

function imageToPdf(bytes: Uint8Array, fileId: string): Uint8Array {
  const format = imageFormat(bytes);
  if (!format) {
    throw new ConversionError(
      'unreadable',
      'This image could not be read. Save it again as PNG or JPG and upload it.',
    );
  }

  const doc = new jsPDF({
    unit: 'pt',
    format: 'a4',
    orientation: 'portrait',
    compress: true,
    putOnlyUsedFonts: true,
  });
  doc.setFileId(fileId);
  doc.setCreationDate(FIXED_DATE);

  let width: number;
  let height: number;
  try {
    const properties = doc.getImageProperties(bytes);
    width = properties.width;
    height = properties.height;
  } catch {
    throw new ConversionError(
      'unreadable',
      'This image could not be read. Save it again as PNG or JPG and upload it.',
    );
  }
  if (!(width > 0) || !(height > 0)) {
    throw new ConversionError(
      'unreadable',
      'This image could not be read. Save it again as PNG or JPG and upload it.',
    );
  }

  const maxWidth = PAGE_WIDTH - IMAGE_MARGIN * 2;
  const maxHeight = PAGE_HEIGHT - IMAGE_MARGIN * 2;
  const scale = Math.min(maxWidth / width, maxHeight / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  try {
    doc.addImage(
      bytes,
      format,
      (PAGE_WIDTH - drawWidth) / 2,
      (PAGE_HEIGHT - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
  } catch {
    throw new ConversionError(
      'unreadable',
      'This image could not be read. Save it again as PNG or JPG and upload it.',
    );
  }

  return new Uint8Array(doc.output('arraybuffer'));
}

export async function convertToPdf(input: ConversionInput, options: ConvertOptions = {}): Promise<ConversionResult> {
  const detection = detectKind(input.name, input.type);
  if (detection.kind === 'unsupported') {
    throw new ConversionError('unsupported', detection.message ?? 'This file type is not supported.');
  }

  const kind = detection.kind;
  if (kind === 'pdf') return { kind, pdf: input.bytes, warnings: [] };

  const fileId = await deterministicFileId(input.bytes);
  if (kind === 'image') {
    return { kind, pdf: imageToPdf(input.bytes, fileId), warnings: [] };
  }

  if (!options.fonts) {
    throw new ConversionError('font', 'The built-in fonts are not available.');
  }

  let blocks: DocBlock[];
  let warnings: string[] = [];
  if (kind === 'docx') {
    const converted = await docxToBlocks(input.bytes);
    blocks = converted.blocks;
    warnings = converted.warnings;
  } else {
    const decoded = decodeText(input.bytes);
    warnings = decoded.warnings;
    blocks = kind === 'md' ? markdownToBlocks(decoded.text) : textToBlocks(decoded.text);
  }

  if (!blocksHaveText(blocks)) {
    throw new ConversionError('empty', 'This file has no text to convert.');
  }

  const layout = await renderBlocksToPdf(blocks, { fonts: options.fonts, fileId });
  return { kind, pdf: layout.pdf, warnings: [...warnings, ...layout.warnings] };
}
