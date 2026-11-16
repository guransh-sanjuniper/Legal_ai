import { describe, expect, it } from 'vitest';
import {
  createImportQueue,
  type ConversionOutcome,
  type DocumentToAdd,
  type ImportInput,
  type ImportQueueDeps,
  type PrepareOutcome,
  type QueueEntry,
} from './importQueue';
import type { ConvertKind } from './convert/types';

function input(name: string, size = 100, type = ''): ImportInput {
  return { name, size, type, arrayBuffer: async () => new ArrayBuffer(0) };
}

function kindFor(name: string): ConvertKind {
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.txt')) return 'txt';
  if (name.endsWith('.md')) return 'md';
  return 'image';
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
  deps: ImportQueueDeps;
  entries: () => QueueEntry[];
  prepared: { docId: string; options: { forceIngest?: boolean; forceDefinitions?: boolean } }[];
  added: DocumentToAdd[];
  converted: string[];
}

function harness(overrides: Partial<ImportQueueDeps> = {}): Harness {
  let entryId = 0;
  let now = 1_000;
  let latest: QueueEntry[] = [];
  const prepared: Harness['prepared'] = [];
  const added: DocumentToAdd[] = [];
  const converted: string[] = [];

  const deps: ImportQueueDeps = {
    maxFileBytes: 10_000,
    convert: async (file): Promise<ConversionOutcome> => {
      converted.push(file.name);
      return {
        kind: kindFor(file.name),
        pdf: new TextEncoder().encode(file.name),
        warnings: [],
      };
    },
    hash: async (pdf) => new TextDecoder().decode(pdf),
    findDocument: async () => undefined,
    addDocument: async (doc) => {
      added.push(doc);
    },
    prepare: async (docId, options): Promise<PrepareOutcome> => {
      prepared.push({ docId, options });
      return { stage: 'ready' };
    },
    waitForIdle: async () => undefined,
    onChange: (entries) => {
      latest = entries;
    },
    now: () => ++now,
    makeId: () => `entry-${++entryId}`,
    ...overrides,
  };
  return { deps, entries: () => latest, prepared, added, converted };
}

describe('import queue', () => {
  it('processes files one at a time, in order', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const enter = () => {
      active++;
      maxActive = Math.max(maxActive, active);
    };
    const leave = () => {
      active--;
    };
    const h = harness({
      convert: async (file) => {
        enter();
        order.push(`convert:${file.name}`);
        await tick();
        leave();
        return {
          kind: kindFor(file.name),
          pdf: new TextEncoder().encode(file.name),
          warnings: [],
        };
      },
      prepare: async (docId) => {
        enter();
        order.push(`prepare:${docId}`);
        await tick();
        leave();
        return { stage: 'ready' };
      },
    });
    const queue = createImportQueue(h.deps);

    queue.enqueue([input('a.docx'), input('b.txt'), input('c.md')], 'eng');
    await queue.idle();

    expect(order).toEqual([
      'convert:a.docx',
      'prepare:a.docx',
      'convert:b.txt',
      'prepare:b.txt',
      'convert:c.md',
      'prepare:c.md',
    ]);
    expect(maxActive).toBe(1);
    expect(h.entries().map((entry) => entry.status)).toEqual(['ready', 'ready', 'ready']);
  });

  it('keeps going after a failed conversion', async () => {
    const h = harness({
      convert: async (file) => {
        if (file.name === 'bad.docx') throw new Error('This Word file could not be read.');
        return { kind: kindFor(file.name), pdf: new TextEncoder().encode(file.name), warnings: [] };
      },
    });
    const queue = createImportQueue(h.deps);

    queue.enqueue([input('bad.docx'), input('good.docx')], 'eng');
    await queue.idle();

    const entries = h.entries();
    expect(entries[0].status).toBe('failed');
    expect(entries[0].message).toContain('could not be read');
    expect(entries[1].status).toBe('ready');
    expect(h.prepared.map((call) => call.docId)).toEqual(['good.docx']);
  });

  it('does not let a needs-review document block the next file', async () => {
    const h = harness();
    h.deps.prepare = async (docId, options) => {
      h.prepared.push({ docId, options });
      if (docId === 'review.docx') return { stage: 'needs-review', reviewPages: 3 };
      return { stage: 'ready' };
    };
    const queue = createImportQueue(h.deps);

    queue.enqueue([input('review.docx'), input('next.docx')], 'eng');
    await queue.idle();

    const entries = h.entries();
    expect(entries[0].status).toBe('needs_review');
    expect(entries[0].reviewPages).toBe(3);
    expect(entries[1].status).toBe('ready');
    expect(h.prepared.map((call) => call.docId)).toEqual(['review.docx', 'next.docx']);
  });

  it('reuses an existing document for a duplicate hash', async () => {
    const h = harness({
      findDocument: async (id) => (id === 'same.pdf' ? { id: 'same.pdf', name: 'Existing.pdf' } : undefined),
    });
    const queue = createImportQueue(h.deps);

    queue.enqueue([input('same.pdf')], 'eng');
    await queue.idle();

    const entry = h.entries()[0];
    expect(entry.status).toBe('skipped');
    expect(entry.duplicate).toBe(true);
    expect(entry.docId).toBe('same.pdf');
    expect(entry.message).toContain('already on this device');
    expect(h.added).toHaveLength(0);
    expect(h.prepared).toHaveLength(0);
  });

  it('rejects unsupported types per file and processes the rest', async () => {
    const h = harness();
    const queue = createImportQueue(h.deps);

    queue.enqueue([input('old.doc'), input('ok.docx')], 'eng');
    await queue.idle();

    const entries = h.entries();
    expect(entries[0].status).toBe('skipped');
    expect(entries[0].message).toBe(
      "Word 97-2003 files aren't supported. Save as .docx or PDF and upload again.",
    );
    expect(h.converted).toEqual(['ok.docx']);
    expect(entries[1].status).toBe('ready');
  });

  it('applies the size limit only to converted types, never to PDFs', async () => {
    const h = harness({ maxFileBytes: 100 });
    const queue = createImportQueue(h.deps);

    queue.enqueue(
      [input('big.docx', 101), input('huge.pdf', 101), input('small.txt', 10)],
      'eng',
    );
    await queue.idle();

    const entries = h.entries();
    expect(entries[0].status).toBe('skipped');
    expect(entries[0].message).toContain('over');
    expect(entries[1].status).toBe('ready');
    expect(entries[2].status).toBe('ready');
    expect(h.converted).toEqual(['huge.pdf', 'small.txt']);
  });

  it('keeps going after a failed preparation and retries with the failed stage', async () => {
    let failures = 1;
    const h = harness();
    h.deps.prepare = async (docId, options) => {
      h.prepared.push({ docId, options });
      if (docId === 'a.docx' && failures > 0) {
        failures--;
        return { stage: 'failed', failed: { stage: 'definitions', message: 'Definitions sheet failed.' } };
      }
      return { stage: 'ready' };
    };
    const queue = createImportQueue(h.deps);

    queue.enqueue([input('a.docx'), input('b.docx')], 'eng');
    await queue.idle();

    let entries = h.entries();
    expect(entries[0].status).toBe('failed');
    expect(entries[0].message).toContain('Definitions sheet failed.');
    expect(entries[1].status).toBe('ready');

    queue.retry(entries[0].id);
    await queue.idle();

    entries = h.entries();
    expect(entries[0].status).toBe('ready');
    expect(h.prepared.at(-1)).toEqual({
      docId: 'a.docx',
      options: { forceDefinitions: true },
    });
  });

  it('retries a failed conversion from the retained file', async () => {
    let attempts = 0;
    const h = harness({
      convert: async (file) => {
        attempts++;
        if (attempts === 1) throw new Error('Temporary conversion failure.');
        return { kind: kindFor(file.name), pdf: new TextEncoder().encode(file.name), warnings: [] };
      },
    });
    const queue = createImportQueue(h.deps);

    queue.enqueue([input('retry.docx')], 'eng');
    await queue.idle();
    expect(h.entries()[0].status).toBe('failed');

    queue.retry(h.entries()[0].id);
    await queue.idle();
    expect(h.entries()[0].status).toBe('ready');
    expect(attempts).toBe(2);
  });

  it('removes a waiting file without disturbing the active one', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness();
    h.deps.convert = async (file) => {
      h.converted.push(file.name);
      if (file.name === 'first.docx') await gate;
      return { kind: kindFor(file.name), pdf: new TextEncoder().encode(file.name), warnings: [] };
    };
    const queue = createImportQueue(h.deps);

    queue.enqueue([input('first.docx'), input('second.docx')], 'eng');
    await tick();
    const waiting = h.entries().find((entry) => entry.fileName === 'second.docx');
    expect(waiting?.status).toBe('waiting');
    expect(queue.remove(waiting!.id)).toBe(true);
    expect(h.entries().some((entry) => entry.fileName === 'second.docx')).toBe(false);

    release();
    await queue.idle();

    expect(h.converted).toEqual(['first.docx']);
    expect(h.entries().map((entry) => entry.fileName)).toEqual(['first.docx']);
  });

  it('refuses to remove a file while it is converting', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      convert: async (file) => {
        await gate;
        return { kind: kindFor(file.name), pdf: new TextEncoder().encode(file.name), warnings: [] };
      },
    });
    const queue = createImportQueue(h.deps);

    queue.enqueue([input('active.docx')], 'eng');
    await tick();
    const active = h.entries()[0];
    expect(active.status).toBe('converting');
    expect(queue.remove(active.id)).toBe(false);

    release();
    await queue.idle();
    expect(h.entries()[0].status).toBe('ready');
  });
});
