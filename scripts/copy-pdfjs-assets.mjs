import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, '..');
const source = join(project, 'node_modules', 'pdfjs-dist');
const target = join(project, 'public');

const dirs = ['wasm', 'cmaps', 'standard_fonts'];

await mkdir(target, { recursive: true });
for (const dir of dirs) {
  const from = join(source, dir);
  const to = join(target, dir);
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
  console.log(`copied ${dir} -> public/${dir}`);
}
