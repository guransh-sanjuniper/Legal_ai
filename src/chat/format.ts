// Small pure helpers for chat messages: the time shown on a bubble and the copy action.

const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
const DAY_TIME: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', ...TIME };
const DAY_TIME_YEAR: Intl.DateTimeFormatOptions = { year: 'numeric', ...DAY_TIME };

// Local time for a message from today, otherwise the day and time. Years are shown only when they
// differ from `now`. An unreadable timestamp gives an empty string rather than "Invalid Date".
export function formatMessageTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  if (sameLocalDay(at, now)) return at.toLocaleTimeString(undefined, TIME);
  const opts = at.getFullYear() === now.getFullYear() ? DAY_TIME : DAY_TIME_YEAR;
  return at.toLocaleString(undefined, opts);
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export interface TextClipboard {
  writeText(text: string): Promise<void>;
}

// True when the text reached the clipboard. A missing clipboard (insecure context) or a refused
// write both return false, so the button can say so instead of looking successful.
export async function copyText(text: string, clipboard: TextClipboard | null | undefined): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
