import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';

export interface OcrResult {
  text: string;
  confidence: number;
}

export class OcrEngine {
  private worker: TesseractWorker | null = null;

  constructor(private readonly langs: string) {}

  private async ensure(): Promise<TesseractWorker> {
    if (!this.worker) this.worker = await createWorker(this.langs);
    return this.worker;
  }

  async recognize(canvas: OffscreenCanvas): Promise<OcrResult> {
    const worker = await this.ensure();
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
