import type { IngestMessage } from '../../ingest/ingest.worker';
import type { IngestEvent } from '../../ingest/pipeline';

export type IngestRunnerEvent =
  | { type: 'progress'; done: number; total: number; skipped: number }
  | { type: 'finished'; status: string; review: number; chunks: number }
  | { type: 'locked' }
  | { type: 'error'; message: string }
  | { type: 'idle' };

export interface IngestHandle {
  terminate: () => void;
}

// Thin wrapper over the existing ingest worker. The pipeline, its lock and its incremental
// saves are unchanged; this only lets the library start and observe the same stages.
export function startIngestWorker(docId: string, onEvent: (event: IngestRunnerEvent) => void): IngestHandle {
  const worker = new Worker(new URL('../../ingest/ingest.worker.ts', import.meta.url), { type: 'module' });
  let closed = false;

  const terminate = () => {
    if (closed) return;
    closed = true;
    worker.terminate();
  };

  worker.onmessage = (e: MessageEvent<IngestEvent | { type: 'locked' | 'idle'; docId?: string }>) => {
    const event = e.data;
    switch (event.type) {
      case 'progress':
        onEvent({ type: 'progress', done: event.done, total: event.total, skipped: event.skipped });
        break;
      case 'finished':
        onEvent({ type: 'finished', status: event.status, review: event.review, chunks: event.chunks });
        break;
      case 'locked':
        onEvent({ type: 'locked' });
        terminate();
        break;
      case 'error':
        onEvent({ type: 'error', message: event.message });
        terminate();
        break;
      case 'idle':
        onEvent({ type: 'idle' });
        terminate();
        break;
      default:
        break;
    }
  };

  worker.onerror = (e) => {
    onEvent({ type: 'error', message: e.message || 'The preparation worker stopped unexpectedly.' });
    terminate();
  };

  worker.postMessage({ type: 'ingest', docId } satisfies IngestMessage);
  return { terminate };
}
