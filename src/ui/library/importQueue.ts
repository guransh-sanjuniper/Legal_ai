import { conversionLabel, detectKind, isConvertedKind, oversizeMessage } from './convert/detect';
import type { ConvertKind } from './convert/types';

// The import queue: validation, PDF conversion, duplicate detection and the existing
// preparation path, one file at a time. It is deliberately plain TypeScript with
// injected dependencies so the sequencing rules can be tested without a browser,
// IndexedDB or a model call.

export type QueueStatus =
  | 'waiting'
  | 'converting'
  | 'preparing'
  | 'ready'
  | 'needs_review'
  | 'failed'
  | 'skipped';

export interface ImportInput {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ConversionOutcome {
  kind: ConvertKind;
  pdf: Uint8Array;
  warnings: string[];
}

export interface DocumentToAdd {
  id: string;
  name: string;
  hash: string;
  size: number;
  originalSize: number;
  pdf: Uint8Array;
  createdAt: number;
  ocrLangs: string;
}

export interface PrepareOutcome {
  stage: string;
  reviewPages?: number;
  failed?: { stage: string; message: string };
}

export interface QueueEntry {
  id: string;
  fileName: string;
  size: number;
  status: QueueStatus;
  message: string | null;
  warnings: string[];
  docId: string | null;
  kind: ConvertKind | null;
  duplicate: boolean;
  retryable: boolean;
  failedStage: string | null;
  reviewPages: number | null;
  conversionLabel: string | null;
}

export interface ImportQueueDeps {
  maxFileBytes: number;
  convert(input: ImportInput): Promise<ConversionOutcome>;
  hash(pdf: Uint8Array): Promise<string>;
  findDocument(id: string): Promise<{ id: string; name: string } | undefined>;
  addDocument(doc: DocumentToAdd, conversion: ConversionOutcome): Promise<void>;
  prepare(
    docId: string,
    options: { forceIngest?: boolean; forceDefinitions?: boolean },
  ): Promise<PrepareOutcome>;
  waitForIdle(): Promise<void>;
  onChange: (entries: QueueEntry[]) => void;
  now: () => number;
  makeId: () => string;
}

export interface ImportQueue {
  enqueue(files: ImportInput[], ocrLangs: string): void;
  retry(id: string): void;
  remove(id: string): boolean;
  clearFinished(): void;
  getEntries(): QueueEntry[];
  idle(): Promise<void>;
}

function copyEntry(entry: QueueEntry): QueueEntry {
  return { ...entry, warnings: [...entry.warnings] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createImportQueue(deps: ImportQueueDeps): ImportQueue {
  let entries: QueueEntry[] = [];
  const files = new Map<string, ImportInput>();
  const ocrLangs = new Map<string, string>();
  const idleWaiters: (() => void)[] = [];
  let running = false;

  const notify = () => {
    deps.onChange(entries.map(copyEntry));
  };

  const find = (id: string) => entries.find((entry) => entry.id === id);

  const isActive = (entry: QueueEntry) =>
    entry.status === 'waiting' || entry.status === 'converting' || entry.status === 'preparing';

  const maybeResolveIdle = () => {
    if (running || entries.some(isActive)) return;
    while (idleWaiters.length > 0) idleWaiters.shift()?.();
  };

  const fail = (
    entry: QueueEntry,
    message: string,
    retryable: boolean,
    failedStage: string | null,
  ) => {
    entry.status = 'failed';
    entry.message = message;
    entry.retryable = retryable;
    entry.failedStage = failedStage;
    notify();
  };

  const prepareOptions = (entry: QueueEntry) => {
    if (entry.failedStage === 'ingest') return { forceIngest: true };
    if (entry.failedStage === 'definitions') return { forceDefinitions: true };
    return {};
  };

  const processOne = async (entry: QueueEntry): Promise<void> => {
    if (!entry.docId) {
      entry.status = 'converting';
      entry.message = null;
      notify();

      const file = files.get(entry.id);
      if (!file) {
        fail(entry, 'The file is no longer available. Upload it again.', false, null);
        return;
      }

      let converted: ConversionOutcome;
      try {
        converted = await deps.convert(file);
      } catch (error) {
        fail(entry, errorMessage(error), true, null);
        return;
      }

      let hash: string;
      try {
        hash = await deps.hash(converted.pdf);
      } catch (error) {
        fail(entry, errorMessage(error), true, null);
        return;
      }

      let existing: { id: string; name: string } | undefined;
      try {
        existing = await deps.findDocument(hash);
      } catch (error) {
        fail(entry, errorMessage(error), true, null);
        return;
      }

      if (existing) {
        entry.docId = existing.id;
        entry.kind = converted.kind;
        entry.duplicate = true;
        entry.status = 'skipped';
        entry.message = `${entry.fileName} is already on this device.`;
        entry.warnings = [...converted.warnings];
        files.delete(entry.id);
        notify();
        return;
      }

      const doc: DocumentToAdd = {
        id: hash,
        name: entry.fileName,
        hash,
        size: converted.pdf.byteLength,
        originalSize: entry.size,
        pdf: converted.pdf,
        createdAt: deps.now(),
        ocrLangs: ocrLangs.get(entry.id) ?? 'eng',
      };
      try {
        await deps.addDocument(doc, converted);
      } catch (error) {
        fail(entry, errorMessage(error), true, null);
        return;
      }

      entry.docId = hash;
      entry.kind = converted.kind;
      entry.warnings = [...converted.warnings];
      entry.conversionLabel = conversionLabel(converted.kind);
      files.delete(entry.id);
    }

    entry.status = 'preparing';
    entry.message = null;
    notify();

    const docId = entry.docId;
    if (!docId) {
      fail(entry, 'The converted document is missing. Upload the file again.', true, null);
      return;
    }

    await deps.waitForIdle();
    let outcome: PrepareOutcome;
    try {
      outcome = await deps.prepare(docId, prepareOptions(entry));
    } catch (error) {
      const message = errorMessage(error);
      if (/another document is being prepared/i.test(message)) {
        try {
          await deps.waitForIdle();
          outcome = await deps.prepare(docId, prepareOptions(entry));
        } catch (retryError) {
          fail(entry, errorMessage(retryError), true, null);
          return;
        }
      } else {
        fail(entry, message, true, null);
        return;
      }
    }

    if (outcome.stage === 'ready') {
      entry.status = 'ready';
      entry.message = null;
      entry.reviewPages = null;
      entry.failedStage = null;
      notify();
      return;
    }
    if (outcome.stage === 'needs-review' || outcome.stage === 'needs_review') {
      entry.status = 'needs_review';
      entry.message = null;
      entry.reviewPages = outcome.reviewPages ?? null;
      entry.failedStage = null;
      notify();
      return;
    }

    fail(
      entry,
      outcome.failed?.message ?? 'Preparation did not finish.',
      true,
      outcome.failed?.stage ?? null,
    );
  };

  const pump = () => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        for (;;) {
          const next = entries.find((entry) => entry.status === 'waiting');
          if (!next) break;
          try {
            await processOne(next);
          } catch (error) {
            fail(next, errorMessage(error), true, null);
          }
        }
      } finally {
        running = false;
        if (entries.some((entry) => entry.status === 'waiting')) {
          pump();
        } else {
          maybeResolveIdle();
        }
      }
    })();
  };

  const enqueue = (incoming: ImportInput[], language: string) => {
    for (const file of incoming) {
      const detection = detectKind(file.name, file.type);
      const base: QueueEntry = {
        id: deps.makeId(),
        fileName: file.name,
        size: file.size,
        status: 'waiting',
        message: null,
        warnings: [],
        docId: null,
        kind: detection.kind === 'unsupported' ? null : detection.kind,
        duplicate: false,
        retryable: false,
        failedStage: null,
        reviewPages: null,
        conversionLabel: null,
      };

      if (detection.kind === 'unsupported') {
        base.status = 'skipped';
        base.message = detection.message ?? 'This file type is not supported.';
        entries.push(base);
        continue;
      }

      // PDFs keep today's behaviour: no size limit.
      if (isConvertedKind(detection.kind) && file.size > deps.maxFileBytes) {
        base.status = 'skipped';
        base.message = oversizeMessage(file.name, file.size, deps.maxFileBytes);
        entries.push(base);
        continue;
      }

      files.set(base.id, file);
      ocrLangs.set(base.id, language);
      entries.push(base);
    }
    notify();
    pump();
  };

  const retry = (id: string) => {
    const entry = find(id);
    if (!entry || entry.status !== 'failed' || !entry.retryable) return;
    if (!entry.docId && !files.has(id)) {
      entry.message = 'The file is no longer in memory. Upload it again.';
      notify();
      return;
    }
    entry.status = 'waiting';
    entry.message = null;
    notify();
    pump();
  };

  const remove = (id: string): boolean => {
    const entry = find(id);
    if (!entry) return false;
    if (entry.status === 'converting' || entry.status === 'preparing') return false;
    entries = entries.filter((candidate) => candidate.id !== id);
    files.delete(id);
    ocrLangs.delete(id);
    notify();
    maybeResolveIdle();
    return true;
  };

  const clearFinished = () => {
    entries = entries.filter(
      (entry) => entry.status !== 'ready' && entry.status !== 'needs_review' && entry.status !== 'skipped',
    );
    notify();
    maybeResolveIdle();
  };

  return {
    enqueue,
    retry,
    remove,
    clearFinished,
    getEntries: () => entries.map(copyEntry),
    idle: () =>
      new Promise<void>((resolve) => {
        if (!running && !entries.some(isActive)) {
          resolve();
          return;
        }
        idleWaiters.push(resolve);
      }),
  };
}
