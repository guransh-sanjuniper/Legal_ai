import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { openHarnessDb, type HarnessDBHandle } from './db';
import { runTask } from './runTask';
import { makeTask } from '../tasks/make';
import { CallError, type CallResult, type ResultRow, type RunConfig, type Task } from '../tasks/types';
import { validateClauseItem } from '../tasks/schema';

let n = 0;
const goodText = JSON.stringify([{ clause_no: '1', summary: 'possession', quote: 'hand over' }, { bad: true }]);

function result(over: Partial<CallResult> = {}): CallResult {
  return { text: goodText, finishReason: 'stop', provider: 'test', promptTokens: 10, completionTokens: 20, durationMs: 5, ...over };
}

function cfgWith(calls: (() => Promise<CallResult>)[], saved: ResultRow[], saveFails = false): RunConfig {
  let i = 0;
  return {
    callModel: async () => {
      const next = calls[Math.min(i++, calls.length - 1)];
      return next();
    },
    saveResult: async (row) => {
      if (saveFails) throw new Error('offline');
      if (!saved.some((r) => r.task_id === row.task_id && r.payload)) saved.push(row);
    },
    validateItem: validateClauseItem,
    model: 'm1',
    fallbackModel: 'm2',
    timeoutMs: 1000,
    maxRetries: 3,
    minPieceChars: 10,
    maxSplitDepth: 4,
    backoffMs: () => 0,
    now: () => Date.now(),
    newId: () => `att-${++n}`,
  };
}

async function newTask(db: HarnessDBHandle, input = 'x'.repeat(40), maxTokens = 100): Promise<Task> {
  const t = await makeTask(
    { id: `run1:t${++n}`, runId: 'run1', parentId: null, depth: 0, docHash: 'd', prepFingerprint: 'p', promptVersion: 'v', prompt: 'P', input, maxTokens },
    Date.now(),
  );
  await db.put('tasks', t);
  return t;
}

describe('runTask', () => {
  let db: HarnessDBHandle;
  beforeEach(async () => {
    db = await openHarnessDb();
  });

  it('saves a valid result, keeps valid items only, marks done', async () => {
    const saved: ResultRow[] = [];
    const t = await newTask(db);
    const out = await runTask(db, t, cfgWith([async () => result()], saved));
    expect(out).toBe('done');
    expect(saved.length).toBe(1);
    expect((saved[0].payload as { items: unknown[] }).items.length).toBe(1);
    expect(saved[0].rejected_items).toBe(1);
    expect((await db.get('tasks', t.id))!.status).toBe('done');
  });

  it('http_401 fails fast with no retry', async () => {
    const saved: ResultRow[] = [];
    const t = await newTask(db);
    const out = await runTask(db, t, cfgWith([async () => { throw new CallError('http_401'); }], saved));
    const after = (await db.get('tasks', t.id))!;
    expect(out).toBe('failed');
    expect(after.failureCode).toBe('http_401');
    expect(after.attemptNo).toBe(1);
  });

  it('finish_reason=length splits into two children', async () => {
    const saved: ResultRow[] = [];
    const t = await newTask(db, 'a clause line\n'.repeat(20));
    const out = await runTask(db, t, cfgWith([async () => result({ finishReason: 'length', text: '[' })], saved));
    expect(out).toBe('split');
    expect((await db.get('tasks', `${t.id}/a`))!.parentId).toBe(t.id);
    expect((await db.get('tasks', `${t.id}/b`))!.depth).toBe(1);
    expect((await db.get('tasks', t.id))!.status).toBe('split');
  });

  it('stream_interrupted is retried, then fallback model on last attempt', async () => {
    const saved: ResultRow[] = [];
    const models: string[] = [];
    const cfg = cfgWith([async () => { throw new CallError('stream_interrupted'); }], saved);
    const orig = cfg.callModel;
    cfg.callModel = async (req) => { models.push(req.model); return orig(req); };
    let t = await newTask(db);
    for (let k = 0; k < 4; k++) {
      const out = await runTask(db, (await db.get('tasks', t.id))!, cfg);
      if (out === 'failed') break;
    }
    t = (await db.get('tasks', t.id))!;
    expect(t.status).toBe('failed');
    expect(t.attemptNo).toBe(4);
    expect(models).toEqual(['m1', 'm1', 'm1', 'm2']);
  });

  it('a received raw response is saved again without a new call', async () => {
    const saved: ResultRow[] = [];
    let calls = 0;
    const cfg = cfgWith([async () => { calls++; return result(); }], saved, true);
    const t = await newTask(db);
    const out1 = await runTask(db, t, cfg);
    expect(out1).toBe('save_pending');
    expect(calls).toBe(1);
    const ok = cfgWith([async () => { calls++; return result(); }], saved);
    const out2 = await runTask(db, (await db.get('tasks', t.id))!, ok);
    expect(out2).toBe('done');
    expect(calls).toBe(1);
    expect(saved.length).toBe(1);
  });
});
