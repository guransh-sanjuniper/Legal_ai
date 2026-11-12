import { describe, it, expect } from 'vitest';
import { parseRetryAfter } from './callModel';

describe('parseRetryAfter', () => {
  it('parses seconds', () => {
    expect(parseRetryAfter('12')).toBe(12_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses an HTTP date', () => {
    const now = Date.parse('2026-11-12T06:00:00Z');
    expect(parseRetryAfter('Thu, 12 Nov 2026 06:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Thu, 12 Nov 2026 05:59:00 GMT', now)).toBe(0);
  });

  it('ignores missing or invalid values', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('not-a-date')).toBeNull();
  });
});
