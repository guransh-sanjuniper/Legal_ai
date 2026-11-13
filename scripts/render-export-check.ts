// One-off check: render the synthetic fixture through the real DOCX writer, so the exported file
// can be converted with LibreOffice and its pages inspected.
// Usage: npx esbuild scripts/render-export-check.ts --bundle --platform=node --format=esm --outfile=/tmp/render.mjs && node /tmp/render.mjs out.docx
import { writeFileSync } from 'node:fs';
import { buildBlocksBlocking } from '../src/export/blocks';
import { buildDocx } from '../src/export/docx';
import { buildHtml } from '../src/export/html';
import { fixtureModel } from '../src/export/exportFixture';

const out = process.argv[2] ?? 'export-check.docx';
const model = fixtureModel({ withPrompt: true, clauses: Number(process.env.CLAUSES ?? 6) });
const blocks = buildBlocksBlocking(model);
if (out.endsWith('.html')) {
  writeFileSync(out, buildHtml(blocks, 'Deep Analysis Report'));
  console.log(`wrote ${out}`);
  process.exit(0);
}
const blob = await buildDocx(blocks);
const buf = Buffer.from(await blob.arrayBuffer());
writeFileSync(out, buf);
console.log(`wrote ${out} (${buf.length} bytes)`);
