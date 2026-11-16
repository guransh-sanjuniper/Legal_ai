import type { ConvertKind, DetectedKind } from './types';

// Detection is by extension first (users rename files), then by MIME type. The picker
// deliberately lists common unsupported types too, so the user gets the plain message
// instead of a silently hidden file.

const EXTENSION_KINDS: Record<string, ConvertKind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.txt': 'txt',
  '.md': 'md',
  '.markdown': 'md',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
};

const MIME_KINDS: Record<string, ConvertKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'image/png': 'image',
  'image/jpeg': 'image',
};

const WORD_MESSAGE = "Word 97-2003 files aren't supported. Save as .docx or PDF and upload again.";
const WORD_OTHER_MESSAGE = "This Word format isn't supported. Save as .docx or PDF and upload again.";
const RTF_MESSAGE = "Rich Text (.rtf) files aren't supported. Save as .docx or PDF and upload again.";
const EXCEL_MESSAGE = "Excel files aren't supported. Save as PDF and upload again.";
const POWERPOINT_MESSAGE = "PowerPoint files aren't supported. Save as PDF and upload again.";
const GIF_MESSAGE = "GIF images aren't supported. Save it as PNG or JPG and upload again.";
const IMAGE_MESSAGE = "This image format isn't supported. Save it as PNG or JPG and upload again.";
const OTHER_MESSAGE =
  "This file type isn't supported. Upload a PDF, Word (.docx), text (.txt or .md) or image (.png or .jpg) file.";

const UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  '.doc': WORD_MESSAGE,
  '.dot': WORD_MESSAGE,
  '.docm': WORD_OTHER_MESSAGE,
  '.dotx': WORD_OTHER_MESSAGE,
  '.docx.bak': WORD_OTHER_MESSAGE,
  '.rtf': RTF_MESSAGE,
  '.xls': EXCEL_MESSAGE,
  '.xlsx': EXCEL_MESSAGE,
  '.xlsm': EXCEL_MESSAGE,
  '.csv': EXCEL_MESSAGE,
  '.ppt': POWERPOINT_MESSAGE,
  '.pptx': POWERPOINT_MESSAGE,
  '.pptm': POWERPOINT_MESSAGE,
  '.gif': GIF_MESSAGE,
  '.webp': IMAGE_MESSAGE,
  '.bmp': IMAGE_MESSAGE,
  '.tif': IMAGE_MESSAGE,
  '.tiff': IMAGE_MESSAGE,
  '.heic': IMAGE_MESSAGE,
  '.heif': IMAGE_MESSAGE,
};

const UNSUPPORTED_MIMES: Record<string, string> = {
  'application/msword': WORD_MESSAGE,
  'application/vnd.ms-word': WORD_MESSAGE,
  'application/rtf': RTF_MESSAGE,
  'text/rtf': RTF_MESSAGE,
  'application/vnd.ms-excel': EXCEL_MESSAGE,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': EXCEL_MESSAGE,
  'application/vnd.ms-powerpoint': POWERPOINT_MESSAGE,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': POWERPOINT_MESSAGE,
  'image/gif': GIF_MESSAGE,
};

export const CONVERTED_KINDS: ConvertKind[] = ['docx', 'txt', 'md', 'image'];

export function isConvertedKind(kind: ConvertKind): boolean {
  return kind !== 'pdf';
}

function extensionOf(name: string): string {
  const base = name.trim().toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot > -1 ? base.slice(dot) : '';
}

export interface Detection {
  kind: DetectedKind;
  message?: string;
}

export function detectKind(name: string, type: string): Detection {
  const ext = extensionOf(name);
  if (ext && EXTENSION_KINDS[ext]) return { kind: EXTENSION_KINDS[ext] };
  if (ext && UNSUPPORTED_EXTENSIONS[ext]) return { kind: 'unsupported', message: UNSUPPORTED_EXTENSIONS[ext] };

  const mime = (type || '').toLowerCase().split(';')[0].trim();
  if (mime && MIME_KINDS[mime]) return { kind: MIME_KINDS[mime] };
  if (mime && UNSUPPORTED_MIMES[mime]) return { kind: 'unsupported', message: UNSUPPORTED_MIMES[mime] };

  return { kind: 'unsupported', message: OTHER_MESSAGE };
}

// The library row's small note: "Converted from Word" etc.
export function conversionLabel(kind: ConvertKind): 'Word' | 'text' | 'Markdown' | 'image' | null {
  switch (kind) {
    case 'docx':
      return 'Word';
    case 'txt':
      return 'text';
    case 'md':
      return 'Markdown';
    case 'image':
      return 'image';
    default:
      return null;
  }
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function oversizeMessage(name: string, size: number, maxBytes: number): string {
  const limit =
    maxBytes >= 1024 * 1024 && maxBytes % (1024 * 1024) === 0
      ? `${maxBytes / (1024 * 1024)} MB`
      : formatFileSize(maxBytes);
  return `${name} is ${formatFileSize(size)}. Files over ${limit} aren't imported. Use a smaller file.`;
}
