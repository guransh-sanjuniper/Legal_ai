import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { itemsToText } from './textItems';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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
  return pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    // These are copied from pdfjs-dist into public/ by scripts/copy-pdfjs-assets.mjs.
    // Without wasmUrl, CCITT/JBIG2 masks fail to decode and scanned pages render almost blank.
    wasmUrl: '/wasm/',
    cMapUrl: '/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/standard_fonts/',
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
