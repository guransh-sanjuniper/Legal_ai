import { describe, expect, it } from 'vitest';
import type { ClauseRecord, OutlineItem } from '../../drafter/types';
import {
  analyseWriteState,
  decideWriteStart,
  sourceGate,
  writeProgress,
  writeStartReason,
  type WriteCounts,
  type WriteStartAction,
  type WriteStartInput,
} from './writeProgress';

function item(id: string): OutlineItem {
  return { id, level: 1, title: id, purpose: '', kind: 'clause', bindingIds: [] };
}

function record(
  fp: string,
  status: ClauseRecord['status'],
  text = 'Text.',
): ClauseRecord {
  return {
    text,
    status,
    itemFingerprint: fp,
    sourceBindingIds: [],
    model: 'm',
    generatedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
  };
}

const fp = (entry: OutlineItem) => `${entry.id}:fp`;

function counts(over: Partial<WriteCounts> = {}): WriteCounts {
  return {
    total: 10,
    done: 0,
    verbatim: 0,
    writing: 0,
    failed: 0,
    stale: 0,
    pending: 10,
    ...over,
  };
}

function decision(over: Partial<WriteStartInput> = {}): WriteStartAction {
  return decideWriteStart({
    counts: counts(),
    outlineStale: false,
    sourcesStale: false,
    sourcesUnconfirmed: false,
    running: false,
    lockHeld: false,
    userStopped: false,
    startedThisVisit: false,
    pendingOnlyStart: true,
    ...over,
  });
}

describe('write progress', () => {
  it('classifies done, verbatim, stale, failed and pending records', () => {
    const items = [item('done'), item('verbatim'), item('stale'), item('failed'), item('missing')];
    const clauses: Record<string, ClauseRecord> = {
      done: record('done:fp', 'done'),
      verbatim: record('verbatim:fp', 'verbatim'),
      stale: record('old:fp', 'done'),
      failed: record('failed:fp', 'failed', 'Old failed text.'),
    };
    const state = analyseWriteState(items, clauses, fp, 2);

    expect(state.counts).toEqual({
      total: 5,
      done: 1,
      verbatim: 1,
      writing: 2,
      failed: 1,
      stale: 1,
      pending: 1,
    });
    expect(state.pendingIds).toEqual(['stale', 'missing']);
  });

  it('treats a stored writing record as pending when no call is active', () => {
    const items = [item('a')];
    const state = analyseWriteState(items, { a: record('a:fp', 'writing') }, fp, 0);
    expect(state.counts.pending).toBe(1);
    expect(state.counts.writing).toBe(0);
    expect(state.pendingIds).toEqual(['a']);
  });

  it('shows 0 percent before the first section finishes', () => {
    expect(writeProgress(counts({ total: 40, pending: 40 }))).toEqual({
      done: 0,
      total: 40,
      percent: 0,
      label: '0 of 40 sections done',
      complete: false,
    });
  });

  it('shows partial progress on a revisit', () => {
    const progress = writeProgress(counts({ total: 40, done: 12, pending: 28 }));
    expect(progress).toMatchObject({ done: 12, total: 40, percent: 30, complete: false });
    expect(progress.label).toBe('12 of 40 sections done');
  });

  it('counts verbatim sections as done immediately', () => {
    const progress = writeProgress(counts({ total: 5, verbatim: 5, pending: 0 }));
    expect(progress).toMatchObject({ done: 5, percent: 100, complete: true });
  });

  it('does not complete when a section failed', () => {
    const progress = writeProgress(counts({ total: 10, done: 8, failed: 2, pending: 0 }));
    expect(progress).toMatchObject({ done: 8, percent: 80, complete: false });
  });

  it('excludes stale sections from done', () => {
    const progress = writeProgress(counts({ total: 10, done: 8, stale: 2, pending: 0 }));
    expect(progress).toMatchObject({ done: 8, percent: 80, complete: false });
  });

  it('clamps percent when the counts are inconsistent', () => {
    const progress = writeProgress(counts({ total: 40, done: 50, pending: 0 }));
    expect(progress).toMatchObject({ done: 40, percent: 100, complete: true });
    expect(progress.label).toBe('40 of 40 sections done');
  });

  it('handles a draft with no sections', () => {
    expect(writeProgress(counts({ total: 0, pending: 0 }))).toMatchObject({
      done: 0,
      total: 0,
      percent: 0,
      label: 'No sections',
      complete: false,
    });
  });
});

describe('source gate', () => {
  it('ignores stale leftover source text when no source is needed', () => {
    expect(sourceGate(true, true)).toEqual({ stale: false, unconfirmed: false });
    expect(
      decision({
        counts: counts({ done: 4, pending: 6 }),
        sourcesStale: sourceGate(true, true).stale,
        sourcesUnconfirmed: sourceGate(true, true).unconfirmed,
      }),
    ).toBe('start');
  });

  it('classifies stale and unconfirmed only when the gate is closed', () => {
    expect(sourceGate(false, true)).toEqual({ stale: true, unconfirmed: false });
    expect(sourceGate(false, false)).toEqual({ stale: false, unconfirmed: true });
  });
});

describe('write start reasons', () => {
  it('maps every blocked or wait result to a plain reason', () => {
    for (const action of ['blocked:outline', 'blocked:sources', 'blocked:lock', 'wait'] as const) {
      const reason = writeStartReason(action);
      expect(typeof reason).toBe('string');
      expect((reason ?? '').length).toBeGreaterThan(10);
    }
    expect(writeStartReason('start')).toBeNull();
    expect(writeStartReason('attach')).toBeNull();
    expect(writeStartReason('finished')).toBeNull();
  });

  it('uses the reason that matches a paused or failed wait', () => {
    expect(writeStartReason('wait', { userStopped: true })).toContain('Resume');
    expect(writeStartReason('wait', { failed: 2 })).toContain('need attention');
  });
});

describe('write auto-start decision', () => {
  it('attaches to an existing run instead of starting another', () => {
    expect(decision({ running: true })).toBe('attach');
    expect(decision({ running: true, outlineStale: true })).toBe('attach');
  });

  it('never starts twice in one visit', () => {
    expect(decision({ counts: counts({ pending: 10 }) })).toBe('start');
    expect(decision({ startedThisVisit: true, counts: counts({ pending: 10 }) })).toBe('wait');
  });

  it('blocks when the outline is stale', () => {
    expect(decision({ outlineStale: true })).toBe('blocked:outline');
  });

  it('blocks when the sources are stale or unconfirmed', () => {
    expect(decision({ sourcesStale: true })).toBe('blocked:sources');
    expect(decision({ sourcesUnconfirmed: true })).toBe('blocked:sources');
  });

  it('finishes when every section is fresh done or verbatim', () => {
    expect(decision({ counts: counts({ done: 7, verbatim: 3, pending: 0 }) })).toBe('finished');
    expect(decision({ counts: counts({ total: 0, pending: 0 }) })).toBe('finished');
  });

  it('blocks when another tab holds the draft lock', () => {
    expect(decision({ lockHeld: true, counts: counts({ pending: 4 }) })).toBe('blocked:lock');
  });

  it('waits after the user stops', () => {
    expect(decision({ userStopped: true, counts: counts({ pending: 4 }) })).toBe('wait');
  });

  it('starts when pending or stale sections remain and none failed', () => {
    expect(decision({ counts: counts({ done: 4, pending: 6 }) })).toBe('start');
    expect(decision({ counts: counts({ done: 4, stale: 2, pending: 4 }) })).toBe('start');
  });

  it('starts pending sections while leaving failed ones alone when the engine supports it', () => {
    expect(
      decision({ counts: counts({ done: 4, failed: 2, pending: 4 }), pendingOnlyStart: true }),
    ).toBe('start');
    expect(
      decision({ counts: counts({ done: 4, failed: 2, pending: 4 }), pendingOnlyStart: false }),
    ).toBe('wait');
  });

  it('waits when only failed sections remain', () => {
    expect(decision({ counts: counts({ done: 8, failed: 2, pending: 0 }) })).toBe('wait');
  });
});
