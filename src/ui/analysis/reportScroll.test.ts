import { describe, expect, it } from 'vitest';
import {
  REPORT_SCROLL_OFFSET,
  REPORT_TOP_SKIP,
  reportScrollBehavior,
  reportScrollTop,
  shouldScrollToReport,
} from './reportScroll';

describe('shouldScrollToReport', () => {
  it('scrolls when a run just finished and the report is lower on the screen', () => {
    expect(
      shouldScrollToReport({ finishedThisVisit: true, reportShown: true, reportTop: 300 }),
    ).toBe(true);
  });

  it('does not scroll when the report top is already at or near the top of the viewport', () => {
    expect(
      shouldScrollToReport({ finishedThisVisit: true, reportShown: true, reportTop: REPORT_TOP_SKIP }),
    ).toBe(false);
    expect(
      shouldScrollToReport({ finishedThisVisit: true, reportShown: true, reportTop: 50 }),
    ).toBe(false);
    expect(
      shouldScrollToReport({ finishedThisVisit: true, reportShown: true, reportTop: -400 }),
    ).toBe(false);
  });

  it('does not scroll on load or a restored report, even when the report is far down', () => {
    expect(
      shouldScrollToReport({ finishedThisVisit: false, reportShown: true, reportTop: 900 }),
    ).toBe(false);
  });

  it('does not scroll when the run failed or nothing is shown', () => {
    expect(
      shouldScrollToReport({ finishedThisVisit: true, reportShown: false, reportTop: 900 }),
    ).toBe(false);
    expect(
      shouldScrollToReport({ finishedThisVisit: true, reportShown: true, reportTop: null }),
    ).toBe(false);
  });
});

describe('reportScrollBehavior', () => {
  it('jumps when reduced motion is requested and scrolls smoothly otherwise', () => {
    expect(reportScrollBehavior(true)).toBe('auto');
    expect(reportScrollBehavior(false)).toBe('smooth');
  });
});

describe('reportScrollTop', () => {
  it('leaves the configured gap above the report', () => {
    expect(reportScrollTop(500, 1200)).toBe(1200 + 500 - REPORT_SCROLL_OFFSET);
    expect(reportScrollTop(500, 1200, 40)).toBe(1660);
  });

  it('never returns a negative position', () => {
    expect(reportScrollTop(10, 0)).toBe(0);
  });
});
