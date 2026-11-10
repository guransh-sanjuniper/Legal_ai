import { describe, it, expect } from 'vitest';
import { buildWindows } from './windows';

describe('embedding windows', () => {
  const sentence = 'The Developer shall hand over possession of the unit to the Purchaser on the agreed date. ';

  it('keeps a short chunk as one window', () => {
    const windows = buildWindows('Short clause text.');
    expect(windows).toHaveLength(1);
    expect(windows[0].text).toBe('Short clause text.');
  });

  it('splits a long chunk into windows of at most ~400 tokens', () => {
    const text = sentence.repeat(400); // ~12k chars, ~3000 tokens
    const windows = buildWindows(text, 400);
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(w.tokenEst).toBeLessThanOrEqual(400 + 10);
  });

  it('cuts only between sentences and covers the whole text once', () => {
    const text = sentence.repeat(120);
    const windows = buildWindows(text, 400);
    expect(windows.map((w) => w.text).join('')).toBe(text);
    for (const w of windows.slice(0, -1)) expect(w.text.trimEnd().endsWith('.')).toBe(true);
    expect(windows.map((w) => w.windowIndex)).toEqual(windows.map((_, i) => i));
  });

  it('gives a single sentence longer than the limit its own window', () => {
    const giant = 'word '.repeat(4000) + '.';
    const windows = buildWindows(giant, 100);
    expect(windows).toHaveLength(1);
    expect(windows[0].text).toBe(giant);
  });
});
