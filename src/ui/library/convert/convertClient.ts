import { detectKind } from './detect';
import { ConversionError, type ConversionInput, type ConversionResult, type WorkerRequest, type WorkerResponse } from './types';

// Lazy worker for PDF conversion. This module is imported by the main bundle, but the
// mammoth/jsPDF code lives in the worker chunk and is only loaded when a converted file
// is actually imported. There is deliberately no main-thread fallback: if the browser
// cannot run this worker, the import fails with a plain message.

const TIMEOUT_MS = 180_000;

interface Pending {
  resolve: (result: ConversionResult) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let sequence = 0;
let tail: Promise<void> = Promise.resolve();
const pending = new Map<number, Pending>();

function failAll(error: unknown): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(error);
  }
  worker?.terminate();
  worker = null;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL('./convert.worker.ts', import.meta.url), { type: 'module' });
  created.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.ok) {
      entry.resolve({
        kind: message.kind,
        pdf: new Uint8Array(message.pdf),
        warnings: message.warnings,
      });
    } else {
      entry.reject(new ConversionError(message.code, message.message));
    }
  };
  created.onerror = () => {
    failAll(
      new ConversionError(
        'worker',
        'The PDF converter stopped unexpectedly. Reload the page and try the file again.',
      ),
    );
  };
  created.onmessageerror = () => {
    failAll(
      new ConversionError(
        'worker',
        'The PDF converter could not read the file. Try saving it as a PDF and uploading that.',
      ),
    );
  };
  worker = created;
  return created;
}

function run(input: ConversionInput): Promise<ConversionResult> {
  const detection = detectKind(input.name, input.type);
  if (detection.kind === 'unsupported') {
    return Promise.reject(
      new ConversionError('unsupported', detection.message ?? 'This file type is not supported.'),
    );
  }
  if (detection.kind === 'pdf') {
    return Promise.resolve({ kind: 'pdf', pdf: input.bytes, warnings: [] });
  }

  return new Promise<ConversionResult>((resolve, reject) => {
    let activeWorker: Worker;
    try {
      activeWorker = ensureWorker();
    } catch {
      reject(
        new ConversionError(
          'worker',
          'This browser cannot convert files. Upload a PDF instead, or reload the page and try again.',
        ),
      );
      return;
    }

    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new ConversionError(
          'timeout',
          'Converting this file took too long. Try a smaller file, or save it as a PDF and upload that.',
        ),
      );
      worker?.terminate();
      worker = null;
    }, TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    const bytes =
      input.bytes.byteOffset === 0 && input.bytes.byteLength === input.bytes.buffer.byteLength
        ? (input.bytes.buffer as ArrayBuffer)
        : (input.bytes.slice().buffer as ArrayBuffer);
    const request: WorkerRequest = { id, name: input.name, type: input.type, bytes };
    activeWorker.postMessage(request, [bytes]);
  });
}

export function convertFile(input: ConversionInput): Promise<ConversionResult> {
  const next = tail.then(() => run(input));
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
