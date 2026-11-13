import { describe, it, expect } from 'vitest';
import { copyText, formatMessageTime } from './format';

// Local-time fixtures, so the tests do not depend on the machine's time zone.
const now = new Date(2026, 10, 13, 15, 0);
const iso = (d: Date) => d.toISOString();

describe('formatMessageTime', () => {
  it('shows only the time for a message from today', () => {
    const at = new Date(2026, 10, 13, 9, 30);
    expect(formatMessageTime(iso(at), now)).toBe(at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
  });

  it('shows the day and time for an earlier day this year', () => {
    const at = new Date(2026, 9, 2, 18, 5);
    expect(formatMessageTime(iso(at), now)).toBe(
      at.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('adds the year when the message is from another year', () => {
    const at = new Date(2025, 0, 20, 8, 0);
    expect(formatMessageTime(iso(at), now)).toBe(
      at.toLocaleString(undefined, { year: 'numeric', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('gives an empty string for a timestamp it cannot read', () => {
    expect(formatMessageTime('not a date', now)).toBe('');
  });
});

describe('copyText', () => {
  it('writes the exact text and reports success', async () => {
    const written: string[] = [];
    const clipboard = { writeText: async (t: string) => void written.push(t) };
    const text = '**Deposit:** Rs 50,000\n\n- Clause 4';
    expect(await copyText(text, clipboard)).toBe(true);
    expect(written).toEqual([text]);
  });

  it('reports failure when the clipboard refuses the write', async () => {
    const clipboard = { writeText: async () => Promise.reject(new Error('denied')) };
    expect(await copyText('x', clipboard)).toBe(false);
  });

  it('reports failure when there is no clipboard (insecure context)', async () => {
    expect(await copyText('x', null)).toBe(false);
    expect(await copyText('x', undefined)).toBe(false);
  });
});
