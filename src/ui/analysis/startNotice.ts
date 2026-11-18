import { KEEP_OPEN_NOTICE } from '../help/pageHelp';

export { KEEP_OPEN_NOTICE };

// "Do not show this again" for the Deep Analysis start pop-up. Render-only preference.
export const HIDE_START_NOTICE_KEY = 'legal-app.hideStartNotice';

export function readHideStartNotice(): boolean {
  try {
    return localStorage.getItem(HIDE_START_NOTICE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeHideStartNotice(): void {
  try {
    localStorage.setItem(HIDE_START_NOTICE_KEY, 'true');
  } catch {
    // An unavailable localStorage reads as "not hidden"; nothing to do.
  }
}
