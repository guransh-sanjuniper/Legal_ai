import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let base = '';

beforeAll(async () => {
  // Same copy step used by predev/prebuild/pretest.
  execFileSync(process.execPath, ['scripts/copy-pdfjs-assets.mjs'], { cwd: process.cwd(), stdio: 'ignore' });
  server = await createServer({
    root: process.cwd(),
    logLevel: 'silent',
    server: { port: 0, strictPort: false },
  });
  await server.listen();
  base = server.resolvedUrls?.local?.[0] ?? '';
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('pdf.js assets', () => {
  it('serves wasm with the application/wasm content type', async () => {
    expect(base).not.toBe('');
    const res = await fetch(`${base}wasm/jbig2.wasm`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/wasm');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
  });

  it('serves cmaps and standard fonts', async () => {
    const cmap = await fetch(`${base}cmaps/Adobe-Japan1-UCS2.bcmap`);
    expect(cmap.status).toBe(200);
    expect((await cmap.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const font = await fetch(`${base}standard_fonts/FoxitFixed.pfb`);
    expect(font.status).toBe(200);
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
