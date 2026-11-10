import { openHarnessDb } from '../runner/db';
import { ingestDocument, reocrPage, type IngestEvent } from './pipeline';

export type IngestMessage =
  | { type: 'ingest'; docId: string; recheck?: boolean }
  | { type: 'ocr'; docId: string; pageNo: number };

const ctx = self as unknown as { postMessage: (m: unknown) => void; onmessage: ((e: MessageEvent) => void) | null };
const post = (m: unknown) => ctx.postMessage(m);

ctx.onmessage = (e: MessageEvent<IngestMessage>) => {
  void handle(e.data);
};

async function handle(msg: IngestMessage) {
  await navigator.locks.request(`ingest:${msg.docId}`, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      post({ type: 'locked', docId: msg.docId });
      return;
    }
    try {
      const db = await openHarnessDb();
      const deps = { db, emit: (e: IngestEvent) => post(e) };
      if (msg.type === 'ingest') await ingestDocument(deps, msg.docId, { recheck: msg.recheck });
      else await reocrPage(deps, msg.docId, msg.pageNo);
      post({ type: 'idle', docId: msg.docId });
    } catch (err) {
      post({ type: 'error', message: String(err) });
    }
  });
}
