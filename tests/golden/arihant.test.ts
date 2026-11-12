import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { it, expect, vi } from 'vitest';

const PDF =
  process.env.ARIHANT_PDF ??
  '/home/guransh/Development/Legal App/Testing docs/Arihant_OCR.pdf';


it.skipIf(!fs.existsSync(PDF))(
  'renders a CCITT-mask page with real ink (no missing JBIG2 wasm)',
  async () => {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = await import('@napi-rs/canvas');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfjs-assets-'));
    for (const dir of ['wasm', 'cmaps', 'standard_fonts']) {
      fs.cpSync(path.join(process.cwd(), 'public', dir), path.join(temp, dir), { recursive: true });
    }
    const asset = (dir: string) => pathToFileURL(`${path.join(temp, dir)}${path.sep}`).href;
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(fs.readFileSync(PDF)),
        useSystemFonts: false,
        wasmUrl: asset('wasm'),
        cMapUrl: asset('cmaps'),
        cMapPacked: true,
        standardFontDataUrl: asset('standard_fonts'),
      }).promise;
      try {
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 110 / 72 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let sum = 0;
        let dark = 0;
        let sampled = 0;
        for (let i = 0; i < data.length; i += 4 * 4) {
          sampled++;
          const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
          sum += lum;
          if (lum < 200) dark++;
        }
        const mean = sum / sampled;
        const darkRatio = dark / sampled;
        // eslint-disable-next-line no-console
        console.log({ mean, darkRatio, warnings });
        expect(mean).toBeGreaterThan(230);
        expect(darkRatio).toBeGreaterThan(0.03);
        expect(warnings.filter((w) => /JBig2 failed to initialize/i.test(w))).toEqual([]);
        page.cleanup();
      } finally {
        await doc.loadingTask.destroy();
      }
    } finally {
      warn.mockRestore();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
  120_000,
);
