import { describe, expect, it } from 'vitest';
import { wholeModeAllowed } from './wholeMode';

describe('wholeModeAllowed', () => {
  it('fails closed when the page count is unknown or zero', () => {
    expect(wholeModeAllowed(0, 10)).toBe(false);
    expect(wholeModeAllowed(undefined, 10)).toBe(false);
    expect(wholeModeAllowed(null, 10)).toBe(false);
    expect(wholeModeAllowed(Number.NaN, 10)).toBe(false);
  });

  it('allows a document at or below the limit', () => {
    expect(wholeModeAllowed(9, 10)).toBe(true);
    expect(wholeModeAllowed(10, 10)).toBe(true);
  });

  it('refuses a document above the limit', () => {
    expect(wholeModeAllowed(11, 10)).toBe(false);
  });

  it('honours a custom maximum', () => {
    expect(wholeModeAllowed(20, 25)).toBe(true);
    expect(wholeModeAllowed(25, 25)).toBe(true);
    expect(wholeModeAllowed(26, 25)).toBe(false);
  });
});
