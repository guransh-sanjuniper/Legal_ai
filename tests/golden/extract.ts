import fs from 'node:fs';
import path from 'node:path';
import { itemsToText } from '../../src/ingest/textItems';
import type { PageText } from '../../src/ingest/chunk';

export const KNOWN_PDF_PATHS = [
  process.env.HIRAMOTI_PDF,
  path.join('/home/guransh/Development/Legal App/project/Test Docs', 'HIRAMOTI NAGAR CHSL DA DRAFT FOR MEMBERS 290626.pdf'),
  path.join('/home/guransh/Downloads/Deep_Analyser_Corrected_Project_20261026-1/Test Docs', 'HIRAMOTI NAGAR CHSL DA DRAFT FOR MEMBERS 290626.pdf'),
].filter((p): p is string => !!p);

export function findPdf(): string | null {
  return KNOWN_PDF_PATHS.find((p) => fs.existsSync(p)) ?? null;
}

export async function extractPages(pdfPath: string): Promise<PageText[]> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false }).promise;
  const pages: PageText[] = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.filter((it: any) => 'str' in it);
    pages.push({ pageNo: p, text: itemsToText(items) });
    page.cleanup();
  }
  await doc.loadingTask.destroy();
  return pages;
}
