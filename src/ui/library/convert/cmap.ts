import { ConversionError } from './types';

// Minimal TrueType/OpenType cmap reader. We need glyph coverage only: it lets the
// converter substitute a visible character and warn instead of letting jsPDF drop it.
// Supports cmap formats 4 (BMP) and 12 (full Unicode); both Noto fonts use format 4.

export interface FontCoverage {
  has(codePoint: number): boolean;
}

const cache = new WeakMap<Uint8Array, FontCoverage>();

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function parseFormat4(view: DataView, offset: number, out: Set<number>): void {
  if (offset + 16 > view.byteLength) throw new Error('short format 4');
  const segCount = view.getUint16(offset + 6) / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;

  for (let i = 0; i < segCount; i++) {
    const end = view.getUint16(endCodes + i * 2);
    const start = view.getUint16(startCodes + i * 2);
    const delta = view.getUint16(idDeltas + i * 2);
    const rangeOffsetPos = idRangeOffsets + i * 2;
    const rangeOffset = view.getUint16(rangeOffsetPos);
    if (start > end) continue;

    for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (cp + delta) & 0xffff;
      } else {
        const glyphOffset = rangeOffsetPos + rangeOffset + (cp - start) * 2;
        if (glyphOffset + 2 > view.byteLength) continue;
        glyph = view.getUint16(glyphOffset);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) out.add(cp);
    }
  }
}

function parseFormat12(view: DataView, offset: number, out: Set<number>): void {
  if (offset + 16 > view.byteLength) throw new Error('short format 12');
  const groups = view.getUint32(offset + 12);
  if (groups > 1_000_000) throw new Error('format 12 group count');
  for (let i = 0; i < groups; i++) {
    const at = offset + 16 + i * 12;
    if (at + 12 > view.byteLength) break;
    const start = view.getUint32(at);
    const end = view.getUint32(at + 4);
    const glyph = view.getUint32(at + 8);
    if (start > end) continue;
    for (let cp = start; cp <= end && cp - start < 200_000; cp++) {
      if (glyph + (cp - start) !== 0) out.add(cp);
    }
  }
}

function parseCmap(bytes: Uint8Array): FontCoverage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) throw new Error('short font');
  const numTables = view.getUint16(4);
  let cmapOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    if (at + 16 > bytes.byteLength) break;
    if (tag(view, at) === 'cmap') {
      cmapOffset = view.getUint32(at + 8);
      break;
    }
  }
  if (cmapOffset < 0 || cmapOffset + 4 > bytes.byteLength) throw new Error('no cmap');

  const count = view.getUint16(cmapOffset + 2);
  const subtables: { platform: number; encoding: number; offset: number; format: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = cmapOffset + 4 + i * 8;
    if (at + 8 > bytes.byteLength) break;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const sub = cmapOffset + view.getUint32(at + 4);
    if (sub + 2 > bytes.byteLength) continue;
    subtables.push({ platform, encoding, offset: sub, format: view.getUint16(sub) });
  }

  const unicode = subtables.filter(
    (s) =>
      s.format === 12 ||
      s.format === 4 ||
      s.platform === 0 ||
      (s.platform === 3 && (s.encoding === 1 || s.encoding === 10)),
  );
  const format12 = unicode.find((s) => s.format === 12);
  const format4 = unicode.find((s) => s.format === 4);
  const chosen = format12 ?? format4;
  if (!chosen) throw new Error('no unicode cmap');

  const set = new Set<number>();
  if (chosen.format === 12) parseFormat12(view, chosen.offset, set);
  else parseFormat4(view, chosen.offset, set);

  return { has: (cp: number) => set.has(cp) };
}

export function fontCoverage(bytes: Uint8Array): FontCoverage {
  const cached = cache.get(bytes);
  if (cached) return cached;
  let coverage: FontCoverage;
  try {
    coverage = parseCmap(bytes);
  } catch {
    throw new ConversionError('font', 'The built-in font could not be read. Upload a PDF or try again.');
  }
  cache.set(bytes, coverage);
  return coverage;
}
