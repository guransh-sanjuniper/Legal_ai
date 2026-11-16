import type { DocumentRecord, HarnessDBHandle } from '../../runner/db';
import { sha256Bytes } from '../../ingest/hash';
import { requestPersistence, storageReport } from '../../ingest/storage';
import { getActiveDocId, runPreparation } from './prepare';
import { readPreparationState } from './preparationState';
import { convertFile } from './convert/convertClient';
import { conversionLabel, formatFileSize } from './convert/detect';
import { writeConversionMeta } from './conversionMeta';
import {
  createImportQueue,
  type ConversionOutcome,
  type DocumentToAdd,
  type ImportInput,
  type ImportQueue,
  type PrepareOutcome,
  type QueueEntry,
} from './importQueue';

// Real wiring for the import queue. Like prepare.ts this lives outside React, so a
// queue keeps running when the user changes route. It calls only the existing
// runPreparation path; the harness pipeline, its lock and its schema are untouched.

const DEFAULT_MAX_MB = 50;

function configuredMaxBytes(): number {
  const raw = Number(import.meta.env.VITE_LIBRARY_MAX_FILE_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_MB;
  return mb * 1024 * 1024;
}

let dbHandle: HarnessDBHandle | null = null;
let appQueue: ImportQueue | null = null;
let snapshot: QueueEntry[] = [];
let notice: string | null = null;
const listeners = new Set<(entries: QueueEntry[]) => void>();
const noticeListeners = new Set<(value: string | null) => void>();

function setNotice(value: string | null): void {
  if (value === notice) return;
  notice = value;
  for (const listener of noticeListeners) listener(notice);
}

async function convertInput(input: ImportInput): Promise<ConversionOutcome> {
  const bytes = new Uint8Array(await input.arrayBuffer());
  const result = await convertFile({ name: input.name, type: input.type, bytes });
  return { kind: result.kind, pdf: result.pdf, warnings: result.warnings };
}

async function hashPdf(pdf: Uint8Array): Promise<string> {
  const buffer = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
  return sha256Bytes(buffer);
}

async function findDocument(id: string): Promise<{ id: string; name: string } | undefined> {
  if (!dbHandle) return undefined;
  const doc = await dbHandle.get('documents', id);
  return doc ? { id: doc.id, name: doc.name } : undefined;
}

async function addDocument(doc: DocumentToAdd, conversion: ConversionOutcome): Promise<void> {
  if (!dbHandle) throw new Error('Local storage is not open yet. Reload the page and try again.');

  const report = await storageReport(doc.pdf.byteLength);
  if (!report.fits) {
    setNotice(
      `Quota warning: this file needs about ${formatFileSize(report.neededBytes)} free, but only ` +
        `${formatFileSize(report.free)} is available. Importing may fail.`,
    );
  }

  const pdfBytes = new Uint8Array(doc.pdf);
  const record: DocumentRecord = {
    id: doc.id,
    name: doc.name,
    hash: doc.hash,
    size: doc.size,
    pdf: new Blob([pdfBytes.buffer], { type: 'application/pdf' }),
    createdAt: doc.createdAt,
    status: 'new',
    ocrLangs: doc.ocrLangs,
    pageCount: 0,
    prepFingerprint: null,
    chunkCount: 0,
  };

  try {
    await dbHandle.put('documents', record);
  } catch {
    throw new Error(
      'Could not save the converted PDF on this device. Browser storage may be full. ' +
        'Remove unused documents and try again.',
    );
  }

  const label = conversionLabel(conversion.kind);
  if (label) {
    writeConversionMeta(doc.id, {
      kind: conversion.kind,
      label,
      originalName: doc.name,
      originalSize: doc.originalSize,
      warnings: conversion.warnings,
      convertedAt: doc.createdAt,
    });
  }

  await requestPersistence().catch(() => false);
}

async function prepareDocument(
  docId: string,
  options: { forceIngest?: boolean; forceDefinitions?: boolean },
): Promise<PrepareOutcome> {
  if (!dbHandle) {
    return {
      stage: 'failed',
      failed: { stage: 'ingest', message: 'Local storage is not open yet. Reload the page and try again.' },
    };
  }
  try {
    const state = await runPreparation(docId, { db: dbHandle, ...options });
    return {
      stage: state.stage,
      reviewPages: state.review?.pages,
      failed: state.failed ?? undefined,
    };
  } catch (error) {
    const stored = readPreparationState(docId);
    return {
      stage: 'failed',
      failed:
        stored?.failed ?? {
          stage: stored?.stage ?? 'ingest',
          message: error instanceof Error ? error.message : String(error),
        },
    };
  }
}

async function waitForIdle(): Promise<void> {
  while (getActiveDocId()) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

function makeEntryId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ensureQueue(): ImportQueue {
  if (appQueue) return appQueue;
  appQueue = createImportQueue({
    maxFileBytes: configuredMaxBytes(),
    convert: convertInput,
    hash: hashPdf,
    findDocument,
    addDocument,
    prepare: prepareDocument,
    waitForIdle,
    onChange: (entries) => {
      snapshot = entries;
      for (const listener of listeners) listener(snapshot);
    },
    now: () => Date.now(),
    makeId: makeEntryId,
  });
  return appQueue;
}

export function enqueueFiles(
  files: File[],
  options: { db: HarnessDBHandle; ocrLangs: string },
): void {
  dbHandle = options.db;
  setNotice(null);
  const inputs: ImportInput[] = files.map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
    arrayBuffer: () => file.arrayBuffer(),
  }));
  ensureQueue().enqueue(inputs, options.ocrLangs);
}

export function subscribeImportQueue(listener: (entries: QueueEntry[]) => void): () => void {
  listeners.add(listener);
  listener(snapshot);
  return () => {
    listeners.delete(listener);
  };
}

export function getImportEntries(): QueueEntry[] {
  return snapshot;
}

export function subscribeImportNotice(listener: (value: string | null) => void): () => void {
  noticeListeners.add(listener);
  listener(notice);
  return () => {
    noticeListeners.delete(listener);
  };
}

export function retryImportEntry(id: string): void {
  ensureQueue().retry(id);
}

export function removeImportEntry(id: string): boolean {
  return ensureQueue().remove(id);
}

export function clearFinishedImports(): void {
  ensureQueue().clearFinished();
}
