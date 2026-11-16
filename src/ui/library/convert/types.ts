// Shared types for the library's PDF conversion. This folder is wrapped around the
// existing import path: it only produces PDF bytes, then the harness pipeline runs unchanged.

export type ConvertKind = 'pdf' | 'docx' | 'txt' | 'md' | 'image';

export type DetectedKind = ConvertKind | 'unsupported';

export interface ConversionInput {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export interface ConversionResult {
  kind: ConvertKind;
  pdf: Uint8Array;
  warnings: string[];
}

export type FontScript = 'latin' | 'devanagari';

export type FontProvider = (script: FontScript) => Promise<Uint8Array>;

export interface ConvertOptions {
  fonts?: FontProvider;
}

export type ConversionErrorCode =
  | 'unsupported'
  | 'corrupt'
  | 'empty'
  | 'font'
  | 'unreadable'
  | 'timeout'
  | 'worker';

export class ConversionError extends Error {
  readonly code: ConversionErrorCode;

  constructor(code: ConversionErrorCode, message: string) {
    super(message);
    this.name = 'ConversionError';
    this.code = code;
  }
}

export interface WorkerRequest {
  id: number;
  name: string;
  type: string;
  bytes: ArrayBuffer;
}

export type WorkerResponse =
  | { id: number; ok: true; kind: ConvertKind; warnings: string[]; pdf: ArrayBuffer }
  | { id: number; ok: false; code: ConversionErrorCode; message: string };
