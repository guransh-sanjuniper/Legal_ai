import { describe, it, expect } from 'vitest';
import { buildBlocksBlocking } from './blocks';
import { buildHtml, escapeHtml } from './html';
import { fixtureModel } from './exportFixture';
import { REPORT_FOOTER } from '../analysis/reportModel';

const html = (withPrompt = false) => buildHtml(buildBlocksBlocking(fixtureModel({ withPrompt })), 'Deep Analysis Report');

describe('HTML export', () => {
  it('is one self-contained document with inline CSS and no external requests', () => {
    const out = html();
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toMatch(/<style>/);
    expect(out).not.toMatch(/<link\b/);
    expect(out).not.toMatch(/<script\b/);
    expect(out).not.toMatch(/https?:\/\//);
  });

  it('contains every section in order, numbered correctly, with no Defined Terms', () => {
    const out = html();
    const order = ['1. Overview', '2. Clause Breakdown', '3. Dates and Amounts', '4. Obligations by Party', '5. Timeline', '6. Risk Register', '7. Internal Inconsistencies', '8. Coverage'];
    let at = -1;
    for (const title of order) {
      const found = out.indexOf(`<h2>${title}</h2>`, at + 1);
      expect(found, title).toBeGreaterThan(at);
      at = found;
    }
    expect(out).not.toMatch(/Defined Terms/);
  });

  it('renumbers when Prompt Result is present', () => {
    const out = html(true);
    expect(out.indexOf('<h2>2. Prompt Result</h2>')).toBeGreaterThan(-1);
    expect(out.indexOf('<h2>3. Clause Breakdown</h2>')).toBeGreaterThan(-1);
    expect(out.indexOf('<h2>9. Coverage</h2>')).toBeGreaterThan(-1);
  });

  it('includes the Missing list and the lawyer-review footer', () => {
    const out = html();
    expect(out).toMatch(/Missing clauses and protections/);
    expect(out).toMatch(/governing law/);
    expect(out).toMatch(new RegExp(`<footer>${REPORT_FOOTER}</footer>`));
  });

  it('escapes document text instead of injecting it', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
    const model = fixtureModel();
    model.title.matter = '<script>alert(1)</script>';
    const out = buildHtml(buildBlocksBlocking(model), 'x');
    expect(out).not.toMatch(/<script>alert/);
    expect(out).toMatch(/&lt;script&gt;alert/);
  });

  it('carries print rules for tables and headings', () => {
    const out = html();
    expect(out).toMatch(/@media print/);
    expect(out).toMatch(/table-header-group/);
    expect(out).toMatch(/prefers-color-scheme: dark/);
  });
});
