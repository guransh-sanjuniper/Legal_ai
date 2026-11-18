import { describe, expect, it, vi } from 'vitest';
import {
  TOAST_MS,
  createToastStore,
  draftRunKey,
  isDraftScreen,
  isExpired,
  nextRemaining,
  shouldToastAnalysis,
  shouldToastDraftReady,
  type DraftToastInput,
} from './toast';

const RUN = { startedAt: '2026-11-18T10:00:00.000Z', finishedAt: '2026-11-18T10:04:00.000Z' };

describe('analysis notice trigger', () => {
  it('fires only for a run that finished in this visit with a report on screen', () => {
    expect(shouldToastAnalysis({ finishedThisVisit: true, reportShown: true })).toBe(true);
  });

  it('never fires for a loaded or restored report', () => {
    expect(shouldToastAnalysis({ finishedThisVisit: false, reportShown: true })).toBe(false);
  });

  it('never fires for a failed run with nothing to show', () => {
    expect(shouldToastAnalysis({ finishedThisVisit: true, reportShown: false })).toBe(false);
  });
});

describe('drafter notice trigger', () => {
  const base: DraftToastInput = {
    sawRunStart: true,
    run: RUN,
    runKey: draftRunKey('d1', RUN.startedAt),
    notifiedKeys: [],
    complete: true,
    failedOrStale: false,
    onDraftScreen: false,
  };

  it('fires when a run seen starting finishes with the whole draft written', () => {
    expect(shouldToastDraftReady(base)).toBe(true);
  });

  it('never fires on page load or when reopening an already finished draft', () => {
    expect(shouldToastDraftReady({ ...base, sawRunStart: false })).toBe(false);
  });

  it('never fires while the run is still going', () => {
    expect(shouldToastDraftReady({ ...base, run: { startedAt: RUN.startedAt, finishedAt: null } })).toBe(false);
    expect(shouldToastDraftReady({ ...base, run: null })).toBe(false);
  });

  it('never fires when the user pressed Stop', () => {
    expect(shouldToastDraftReady({ ...base, run: { ...RUN, stopped: true } })).toBe(false);
  });

  it('never fires when a section failed or is stale', () => {
    expect(shouldToastDraftReady({ ...base, complete: false })).toBe(false);
    expect(shouldToastDraftReady({ ...base, failedOrStale: true })).toBe(false);
  });

  it('never fires twice for the same run', () => {
    const key = draftRunKey('d1', RUN.startedAt)!;
    expect(shouldToastDraftReady({ ...base, notifiedKeys: [key] })).toBe(false);
    expect(shouldToastDraftReady({ ...base, runKey: null })).toBe(false);
  });

  it('never fires while the user is already on that draft’s own screen', () => {
    expect(shouldToastDraftReady({ ...base, onDraftScreen: true })).toBe(false);
  });

  it('builds a stable run key and ignores a missing start', () => {
    expect(draftRunKey('d1', RUN.startedAt)).toBe(`d1:${RUN.startedAt}`);
    expect(draftRunKey('d1', null)).toBeNull();
    expect(draftRunKey('', RUN.startedAt)).toBeNull();
  });
});

describe("the draft's own screens", () => {
  it('covers both the write and the review screen', () => {
    expect(isDraftScreen('/draft/d1/write', 'd1')).toBe(true);
    expect(isDraftScreen('/draft/d1/review', 'd1')).toBe(true);
  });

  it('does not cover other pages, other drafts or lookalike paths', () => {
    expect(isDraftScreen('/draft', 'd1')).toBe(false);
    expect(isDraftScreen('/draft/d1', 'd1')).toBe(false);
    expect(isDraftScreen('/draft/d1/plan', 'd1')).toBe(false);
    expect(isDraftScreen('/draft/d2/write', 'd1')).toBe(false);
    expect(isDraftScreen('/draft/d1/write/extra', 'd1')).toBe(false);
    expect(isDraftScreen('/documents', 'd1')).toBe(false);
    expect(isDraftScreen('', 'd1')).toBe(false);
  });
});

describe('toast store', () => {
  it('keeps one toast: a newer one replaces the older one', () => {
    const store = createToastStore();
    const first = store.publish({ text: 'first' });
    const second = store.publish({ text: 'second', actionLabel: 'View report' });
    expect(second.id).not.toBe(first.id);
    expect(store.current()).toEqual(second);
    expect(store.current()?.text).toBe('second');
  });

  it('tells subscribers about each change and stops after unsubscribe', () => {
    const store = createToastStore();
    const seen = vi.fn();
    const unsubscribe = store.subscribe(seen);
    store.publish({ text: 'one' });
    store.publish({ text: 'two' });
    store.dismiss();
    expect(seen).toHaveBeenCalledTimes(3);
    expect(seen.mock.calls[0][0]?.text).toBe('one');
    expect(seen.mock.calls[1][0]?.text).toBe('two');
    expect(seen.mock.calls[2][0]).toBeNull();
    unsubscribe();
    store.publish({ text: 'three' });
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it('dismisses to nothing and dismissing twice is harmless', () => {
    const store = createToastStore();
    store.publish({ text: 'one' });
    store.dismiss();
    expect(store.current()).toBeNull();
    store.dismiss();
    expect(store.current()).toBeNull();
  });
});

describe('auto-dismiss timer', () => {
  it('counts down eight seconds', () => {
    expect(TOAST_MS).toBe(8000);
    expect(nextRemaining(TOAST_MS, 3000)).toBe(5000);
    expect(isExpired(5000)).toBe(false);
  });

  it('holds its remaining time while paused', () => {
    const pausedAt = nextRemaining(TOAST_MS, 2500);
    // Hovered: no time passes, so the same remaining value is passed back unchanged.
    expect(pausedAt).toBe(5500);
    expect(nextRemaining(pausedAt, 0)).toBe(5500);
  });

  it('resumes for exactly the time that was left', () => {
    expect(nextRemaining(5500, 2000)).toBe(3500);
    expect(nextRemaining(3500, 3499)).toBe(1);
    expect(nextRemaining(3500, 3500)).toBe(0);
    expect(isExpired(0)).toBe(true);
  });

  it('never goes below zero or above the full duration', () => {
    expect(nextRemaining(100, 500)).toBe(0);
    expect(nextRemaining(TOAST_MS, -200)).toBe(TOAST_MS);
    expect(nextRemaining(12000, 0)).toBe(TOAST_MS);
    expect(nextRemaining(Number.NaN, 1000)).toBe(TOAST_MS - 1000);
    expect(nextRemaining(1000, Number.NaN)).toBe(1000);
  });
});
