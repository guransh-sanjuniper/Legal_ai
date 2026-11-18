// Leave-guard decisions and wording. Pure: no DOM, no React.
// The behaviour table reflects what the code actually does when an app page changes:
// document preparation and Drafter writing are module-level and keep going; a Deep
// Analysis run depends on its page's retrieval worker and does not survive the page.

export type LeaveJob = 'preparation' | 'analysis' | 'drafter';
export type LeaveBehaviour = 'stops' | 'continues';

export const LEAVE_BEHAVIOUR: Record<LeaveJob, LeaveBehaviour> = {
  preparation: 'continues',
  analysis: 'stops',
  drafter: 'continues',
};

const STOPS_TEXT =
  'Processing is still running. If you change the page, the processing will stop or may fail, ' +
  'and you may have to start it again. Please stay on this page until it finishes. ' +
  'You may use other tabs or other programs meanwhile.';

const CONTINUES_LEAD: Record<LeaveJob, string> = {
  preparation: 'Your document is still being prepared.',
  analysis: 'Processing is still running.',
  drafter: 'Your draft is still being written.',
};

const CONTINUES_REST =
  'It keeps going if you open another page of this app, but it stops if you close or reload this tab. ' +
  'Please keep this tab open until it finishes.';

export function leaveMessage(
  job: LeaveJob,
  behaviour: LeaveBehaviour = LEAVE_BEHAVIOUR[job],
): string {
  if (behaviour === 'stops') return STOPS_TEXT;
  return `${CONTINUES_LEAD[job]} ${CONTINUES_REST}`;
}

export interface NavBlockInput {
  active: boolean;
  href: string;
  currentHref: string;
  target?: string | null;
  download?: boolean;
  modifier?: boolean;
}

// True only for a same-origin in-app navigation to another path or query. External
// links, new tabs, downloads, modifier-clicks, same-page hashes and malformed hrefs
// are not blocked, so the guard can never make an ordinary link unreachable.
export function shouldBlockNav(input: NavBlockInput): boolean {
  if (!input.active || input.modifier || input.download) return false;
  if (input.target && input.target !== '_self') return false;

  let next: URL;
  let current: URL;
  try {
    next = new URL(input.href, input.currentHref);
    current = new URL(input.currentHref);
  } catch {
    return false;
  }
  if (next.origin !== current.origin) return false;
  return next.pathname !== current.pathname || next.search !== current.search;
}
