import { conversionLabel } from './convert/detect';
import type { ConvertKind } from './convert/types';

// The library keeps "this document was converted from Word/text/Markdown/an image" in
// localStorage, keyed by the document id. The harness database and its schema are not
// changed; a missing or unreadable record only means the small note is not shown.

export interface ConversionMeta {
  kind: ConvertKind;
  label: 'Word' | 'text' | 'Markdown' | 'image';
  originalName: string;
  originalSize: number;
  warnings: string[];
  convertedAt: number;
}

const STORAGE_PREFIX = 'legal-app.converted.';
const CONVERTED_KINDS: ConvertKind[] = ['docx', 'txt', 'md', 'image'];

export function conversionMetaKey(docId: string): string {
  return `${STORAGE_PREFIX}${docId}`;
}

export function readConversionMeta(docId: string): ConversionMeta | null {
  try {
    const raw = localStorage.getItem(conversionMetaKey(docId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConversionMeta>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.kind || !CONVERTED_KINDS.includes(parsed.kind)) return null;
    const label = conversionLabel(parsed.kind);
    if (!label) return null;
    return {
      kind: parsed.kind,
      label,
      originalName: typeof parsed.originalName === 'string' ? parsed.originalName : '',
      originalSize: typeof parsed.originalSize === 'number' ? parsed.originalSize : 0,
      warnings: Array.isArray(parsed.warnings)
        ? parsed.warnings.filter((warning): warning is string => typeof warning === 'string')
        : [],
      convertedAt: typeof parsed.convertedAt === 'number' ? parsed.convertedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeConversionMeta(docId: string, meta: ConversionMeta): void {
  try {
    localStorage.setItem(conversionMetaKey(docId), JSON.stringify(meta));
  } catch {
    // Private mode or a full quota: the import still works, only the note is lost.
  }
}

export function clearConversionMeta(docId: string): void {
  try {
    localStorage.removeItem(conversionMetaKey(docId));
  } catch {
    // ignore
  }
}

export function conversionNote(meta: ConversionMeta): string {
  return `Converted from ${meta.label}`;
}
