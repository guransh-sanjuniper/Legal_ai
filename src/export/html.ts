import type { Block } from './blocks';

// HTML writer: one self-contained file (inline CSS, no external requests). It renders the same
// export blocks as the DOCX, so the content and order are identical.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root {
  --bg: #ffffff; --fg: #1b1b19; --muted: #5f5f5a; --border: #d8d8d2; --head: #f2f2ee; --accent: #175a3c;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161614; --fg: #ecece8; --muted: #a5a59f; --border: #3a3a36; --head: #222220; --accent: #7ac6a2; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
main { max-width: 980px; margin: 0 auto; }
h1 { font-size: 26px; margin: 0 0 12px; }
h2 { font-size: 20px; margin: 34px 0 10px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
h3 { font-size: 16px; margin: 22px 0 8px; }
p { margin: 0 0 8px; }
.muted { color: var(--muted); }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 12px; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; }
.toc ol { list-style: none; margin: 6px 0 0; padding-left: 0; columns: 2; column-gap: 32px; }
ul { margin: 0 0 10px; padding-left: 22px; }
li { margin: 4px 0; }
.table-wrap { overflow-x: auto; margin: 0 0 14px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { border: 1px solid var(--border); padding: 6px 8px; vertical-align: top; text-align: left; }
th { background: var(--head); font-weight: 650; }
table.field th { width: 30%; }
.banner { border: 1px solid var(--border); background: var(--head); padding: 10px 12px; border-radius: 8px; margin: 0 0 16px; }
footer { margin-top: 40px; padding-top: 10px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
a { color: var(--accent); }
@media print {
  body { padding: 0; font-size: 11pt; }
  h2 { page-break-after: avoid; }
  h3 { page-break-after: avoid; }
  table { page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  thead { display: table-header-group; }
  .table-wrap { overflow: visible; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; }
}
`;

function renderTable(block: Extract<Block, { kind: 'table' }>, className: string): string {
  const head = block.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const rows = block.rows
    .map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(v).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`)
    .join('\n');
  return `<div class="table-wrap"><table class="${className}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function blocksToHtml(blocks: Block[], title: string): string {
  const body: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'title':
        body.push(`<h1>${escapeHtml(block.text)}</h1>`);
        break;
      case 'meta':
        body.push(
          `<dl class="meta">${block.rows
            .map((r) => `<dt>${escapeHtml(r.label)}</dt><dd>${escapeHtml(r.value)}</dd>`)
            .join('')}</dl>`,
        );
        break;
      case 'toc':
        body.push(
          `<nav class="toc"><ol>${block.entries
            .map((e) => `<li>${escapeHtml(`${e.number}. ${e.title}`)}</li>`)
            .join('')}</ol></nav>`,
        );
        break;
      case 'heading':
        body.push(`<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`);
        break;
      case 'paragraph':
        body.push(`<p class="${block.muted ? 'muted' : ''}">${escapeHtml(block.text)}</p>`);
        break;
      case 'bullets':
        body.push(`<ul>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`);
        break;
      case 'table':
        body.push(renderTable(block, block.columns.length === 2 && block.columns[0] === 'Field' ? 'field' : 'data'));
        break;
      case 'footer':
        body.push(`<footer>${escapeHtml(block.text)}</footer>`);
        break;
    }
  }
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    ...body,
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}

export function buildHtml(blocks: Block[], title: string): string {
  return blocksToHtml(blocks, title);
}
