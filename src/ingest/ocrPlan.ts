import type { OcrCheck } from './ocrCheck';

export type OcrPsm = '3' | '4' | '6';
export type PreprocessMode = 'none' | 'gray' | 'binary';

export interface OcrAttempt {
  text: string;
  confidence: number;
  dpi: number;
  psm: OcrPsm;
  mode: PreprocessMode;
  check: OcrCheck;
}

export interface OcrPlanStep {
  dpi: number;
  psm: OcrPsm;
  mode: PreprocessMode;
}

// General attempt ladder: cheap first, then alternative segmentation and light preprocessing.
// It is not tied to any document or page.
export const OCR_PLAN: OcrPlanStep[] = [
  { dpi: 200, psm: '3', mode: 'none' },
  { dpi: 300, psm: '3', mode: 'none' },
  { dpi: 300, psm: '6', mode: 'none' },
  { dpi: 300, psm: '4', mode: 'none' },
  { dpi: 300, psm: '6', mode: 'gray' },
  { dpi: 300, psm: '6', mode: 'binary' },
  { dpi: 400, psm: '6', mode: 'gray' },
];

export function attemptScore(a: OcrAttempt): number {
  return (
    (a.check.ok ? 1_000_000 : 0) +
    a.check.words * 100 +
    a.confidence -
    a.check.garbledRatio * 1000
  );
}

export function chooseBestAttempt(attempts: OcrAttempt[]): OcrAttempt | null {
  let best: OcrAttempt | null = null;
  for (const a of attempts) {
    if (!best || attemptScore(a) > attemptScore(best)) best = a;
  }
  return best;
}

// Stop once a valid attempt is available. A 200 dpi result is only trusted when it has enough
// words; otherwise 300 dpi gets a chance. Sparse pages still stop once a 300 dpi attempt is valid.
export function shouldStop(attempts: OcrAttempt[]): boolean {
  const best = chooseBestAttempt(attempts);
  if (!best || !best.check.ok) return false;
  if (best.dpi >= 300) return true;
  return best.check.words >= 20;
}
