import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { itemsToText } from './textItems';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;


// pdf.js's main build assumes a DOM for its canvas and SVG filter factories. The ingestion
// pipeline renders inside a Web Worker, so provide OffscreenCanvas/no-op factories there.
class OffscreenCanvasFactory {
  create(width: number, height: number): { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D } {
    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    const context = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    return { canvas, context };
  }
  reset(entry: { canvas: OffscreenCanvas }, width: number, height: number): void {
    entry.canvas.width = Math.max(1, width);
    entry.canvas.height = Math.max(1, height);
  }
  destroy(entry: { canvas: OffscreenCanvas | null; context: OffscreenCanvasRenderingContext2D | null }): void {
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
    entry.canvas = null;
    entry.context = null;
  }
  getNoAlphaContext(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D | null {
    return (canvas.getContext('2d', { alpha: false, willReadFrequently: true }) ??
      canvas.getContext('2d')) as OffscreenCanvasRenderingContext2D | null;
  }
}

class NoopFilterFactory {
  addFilter(): string {
    return 'none';
  }
  addAlphaFilter(): string {
    return 'none';
  }
  addLuminosityFilter(): string {
    return 'none';
  }
  addKnockoutFilter(): string {
    return 'none';
  }
  addHCMFilter(): string {
    return 'none';
  }
  destroy(): void {}
}

export type PdfDoc = pdfjs.PDFDocumentProxy;

export interface NativePage {
  text: string;
  imageCount: number;
}

const IMAGE_OPS = new Set<number>([
  pdfjs.OPS.paintImageXObject,
  pdfjs.OPS.paintInlineImageXObject,
  pdfjs.OPS.paintImageXObjectRepeat,
  pdfjs.OPS.paintInlineImageXObjectGroup,
]);

export function openPdf(bytes: ArrayBuffer): Promise<PdfDoc> {
  // The ingestion pipeline calls this inside a Web Worker. pdf.js's main build uses
  // document.baseURI when cMapUrl/standardFontDataUrl are set, so those two options are only
  // passed on the main thread (review canvas). wasmUrl is worker-safe and is what CCITT/JBIG2
  // masks need.
  const hasDom = typeof document !== 'undefined';
  const origin = typeof location !== 'undefined' && location.origin ? location.origin : '';
  const asset = (path: string) => `${origin}${path}`;
  return pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    wasmUrl: asset('/wasm/'),
    cMapUrl: asset('/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('/standard_fonts/'),
    // In a worker, make pdf.js fetch these assets itself. Without this, pdf.js evaluates its
    // default useWorkerFetch expression, which reads document.baseURI and throws.
    ...(hasDom
      ? {}
      : {
          useWorkerFetch: true,
          disableWorkerRendering: true,
          CanvasFactory: OffscreenCanvasFactory,
          FilterFactory: NoopFilterFactory,
        }),
  }).promise;
}

export function closePdf(doc: PdfDoc): Promise<void> {
  return doc.loadingTask.destroy();
}

export async function extractNativePage(doc: PdfDoc, pageNo: number): Promise<NativePage> {
  const page = await doc.getPage(pageNo);
  try {
    const content = await page.getTextContent();
    const items = content.items.filter((i): i is Extract<typeof i, { str: string }> => 'str' in i);
    const text = itemsToText(items);
    const ops = await page.getOperatorList();
    let imageCount = 0;
    for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) imageCount++;
    return { text, imageCount };
  } finally {
    page.cleanup();
  }
}

export interface RenderedPage {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  width: number;
  height: number;
  inkRatio: number;
}

type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

export async function renderPageInto(doc: PdfDoc, pageNo: number, dpi: number, canvas: CanvasLike): Promise<RenderedPage> {
  const page = await doc.getPage(pageNo);
  try {
    const viewport = page.getViewport({ scale: dpi / 72 });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas: canvas as HTMLCanvasElement }).promise;
    return { ctx, width: canvas.width, height: canvas.height, inkRatio: inkRatio(ctx, canvas.width, canvas.height) };
  } finally {
    page.cleanup();
  }
}

function inkRatio(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number): number {
  const data = ctx.getImageData(0, 0, w, h).data;
  let dark = 0;
  let sampled = 0;
  for (let i = 0; i < data.length; i += 4 * 4) {
    sampled++;
    const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    if (lum < 200) dark++;
  }
  return sampled ? dark / sampled : 0;
}
