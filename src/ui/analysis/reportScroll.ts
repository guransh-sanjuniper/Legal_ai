// Pure decisions for scrolling to the Deep Analysis report after a run finishes.
// The page reports "finished in this visit" itself; nothing here reads storage or the DOM.

// A report whose top is at or above this line is already where the user is looking.
// Negative values mean the user has scrolled past the top of the report.
export const REPORT_TOP_SKIP = 100;
export const REPORT_SCROLL_OFFSET = 24;

export interface ReportScrollInput {
  finishedThisVisit: boolean;
  reportShown: boolean;
  reportTop: number | null;
}

export function shouldScrollToReport(input: ReportScrollInput): boolean {
  if (!input.finishedThisVisit || !input.reportShown || input.reportTop === null) return false;
  return input.reportTop > REPORT_TOP_SKIP;
}

export function reportScrollBehavior(prefersReducedMotion: boolean): ScrollBehavior {
  return prefersReducedMotion ? 'auto' : 'smooth';
}

// Leave a small gap above the report rather than pinning its title to the viewport edge.
export function reportScrollTop(reportTop: number, scrollY: number, offset = REPORT_SCROLL_OFFSET): number {
  return Math.max(0, scrollY + reportTop - offset);
}
