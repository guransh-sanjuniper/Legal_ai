import type { PreprocessMode } from './ocrPlan';

// Otsu threshold for an 8-bit histogram. Exported for tests.
export function otsuThreshold(histogram: number[], total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

// Grayscale/contrast (and optional Otsu binarisation) for OCR. This is deliberately generic:
// no document-specific masks, colours or regions.
export function preprocessCanvas(source: OffscreenCanvas, mode: PreprocessMode): OffscreenCanvas {
  if (mode === 'none') return source;
  const out = new OffscreenCanvas(source.width, source.height);
  const ctx = out.getContext('2d');
  if (!ctx) return source;
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const data = image.data;
  const gray = new Uint8Array(out.width * out.height);
  let min = 255;
  let max = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = Math.round((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000);
    gray[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = Math.round(((gray[p] - min) * 255) / range);
    data[i] = data[i + 1] = data[i + 2] = g;
  }
  if (mode === 'binary') {
    const histogram = new Array(256).fill(0) as number[];
    for (let p = 0; p < gray.length; p++) {
      const g = Math.round(((gray[p] - min) * 255) / range);
      histogram[Math.max(0, Math.min(255, g))]++;
    }
    const threshold = otsuThreshold(histogram, gray.length);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const g = Math.round(((gray[p] - min) * 255) / range);
      const v = g <= threshold ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  }
  ctx.putImageData(image, 0, 0);
  return out;
}
