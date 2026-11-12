import { describe, it, expect } from 'vitest';
import { chooseBestAttempt, shouldStop, type OcrAttempt, OCR_PLAN } from './ocrPlan';
import { otsuThreshold } from './ocrPreprocess';
import type { OcrCheck } from './ocrCheck';

const check = (over: Partial<OcrCheck> = {}): OcrCheck => ({
  ok: false,
  reason: 'too_few_words',
  letters: 0,
  latinShare: 0,
  devanagariShare: 0,
  words: 0,
  garbledRatio: 0,
  ...over,
});

const attempt = (over: Partial<OcrAttempt>): OcrAttempt => ({
  text: '',
  confidence: 0,
  dpi: 300,
  psm: '3',
  mode: 'none',
  check: check(),
  ...over,
});

describe('OCR attempt selection', () => {
  it('prefers a valid attempt over a higher-confidence invalid one', () => {
    const invalid = attempt({ text: '~ : = a', confidence: 90, check: check({ words: 1 }) });
    const valid = attempt({ text: 'The Developer shall pay.', confidence: 70, check: check({ ok: true, reason: null, words: 4 }) });
    expect(chooseBestAttempt([invalid, valid])).toBe(valid);
  });

  it('prefers more words among valid attempts', () => {
    const few = attempt({ text: 'A B C', confidence: 80, check: check({ ok: true, reason: null, words: 3 }) });
    const many = attempt({ text: 'A B C D E', confidence: 70, check: check({ ok: true, reason: null, words: 5 }) });
    expect(chooseBestAttempt([few, many])).toBe(many);
  });

  it('does not stop on a sparse 200 dpi result, but stops at 300 dpi', () => {
    const sparse200 = attempt({ dpi: 200, check: check({ ok: true, reason: null, words: 5 }) });
    expect(shouldStop([sparse200])).toBe(false);
    const dense200 = attempt({ dpi: 200, check: check({ ok: true, reason: null, words: 25 }) });
    expect(shouldStop([dense200])).toBe(true);
    const sparse300 = attempt({ dpi: 300, check: check({ ok: true, reason: null, words: 5 }) });
    expect(shouldStop([sparse300])).toBe(true);
  });

  it('has a bounded general attempt ladder', () => {
    expect(OCR_PLAN.length).toBeGreaterThanOrEqual(4);
    expect(new Set(OCR_PLAN.map((s) => s.psm))).toEqual(new Set(['3', '4', '6']));
  });
});

describe('Otsu threshold', () => {
  it('places the threshold between two dominant peaks', () => {
    const hist = new Array(256).fill(0) as number[];
    for (let i = 0; i < 100; i++) hist[30]++;
    for (let i = 0; i < 100; i++) hist[220]++;
    const t = otsuThreshold(hist, 200);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
  });
});
