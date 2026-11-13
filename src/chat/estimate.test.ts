import { describe, it, expect } from 'vitest';
import { describePass, estimatePass } from './estimate';

const base = { promptText: 'Find the risks.', defsContext: 'Parties: A, B', concurrency: 3, p95DurationMs: null };

describe('estimatePass', () => {
  it('counts one call per section plus the synthesis call', () => {
    const e = estimatePass({ ...base, sectionTexts: ['x'.repeat(400), 'y'.repeat(400), 'z'.repeat(400)] });
    expect(e.calls).toBe(4);
    expect(e.promptTokens).toBeGreaterThan(0);
    expect(e.completionTokens).toBeGreaterThan(0);
    expect(e.costUsd).toBeGreaterThan(0);
  });

  it('has no calls and no time when there are no sections', () => {
    const e = estimatePass({ ...base, sectionTexts: [], p95DurationMs: 30_000 });
    expect(e.calls).toBe(0);
    expect(e.minutes).toBeNull();
  });

  it('leaves time unknown until a call duration has been measured', () => {
    const e = estimatePass({ ...base, sectionTexts: ['x'] });
    expect(e.minutes).toBeNull();
    expect(describePass('Whole document', e)).toContain('time unknown');
  });

  it('turns the measured p95 into minutes using the concurrency', () => {
    // 6 sections + synthesis = 7 calls; 7 / 3 workers = 3 rounds of 60 s.
    const e = estimatePass({ ...base, sectionTexts: Array(6).fill('x'.repeat(100)), p95DurationMs: 60_000 });
    expect(e.minutes).toBe(3);
  });

  it('grows with the number of sections', () => {
    const small = estimatePass({ ...base, sectionTexts: ['x'.repeat(400)] });
    const large = estimatePass({ ...base, sectionTexts: Array(50).fill('x'.repeat(400)) });
    expect(large.promptTokens).toBeGreaterThan(small.promptTokens * 10);
    expect(large.costUsd).toBeGreaterThan(small.costUsd);
  });
});

describe('describePass', () => {
  it('states the calls, tokens and cost before a send', () => {
    const line = describePass('Whole-document scan', estimatePass({ ...base, sectionTexts: Array(4).fill('x'.repeat(400)) }));
    expect(line).toMatch(/^Whole-document scan: 5 model calls, /);
    expect(line).toMatch(/input tokens/);
  });
});
