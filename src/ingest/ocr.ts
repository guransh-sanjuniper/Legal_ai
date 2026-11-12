import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';

import type { OcrPsm } from './ocrPlan';

export interface OcrResult {
  text: string;
  confidence: number;
}

export interface OcrOptions {
  psm?: OcrPsm;
  dpi?: number;
}

export class OcrEngine {
  private worker: TesseractWorker | null = null;

  constructor(private readonly langs: string) {}

  private async ensure(): Promise<TesseractWorker> {
    if (!this.worker) this.worker = await createWorker(this.langs);
    return this.worker;
  }

  async recognize(canvas: OffscreenCanvas, options: OcrOptions = {}): Promise<OcrResult> {
    const worker = await this.ensure();
    if (options.psm || options.dpi) {
      await worker.setParameters({
        // Tesseract accepts the numeric page-segmentation mode as a string.
        tessedit_pageseg_mode: (options.psm ?? '3') as never,
        preserve_interword_spaces: '1',
        user_defined_dpi: String(options.dpi ?? 300),
      });
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const result = await worker.recognize(blob);
    return { text: result.data.text, confidence: result.data.confidence };
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}
