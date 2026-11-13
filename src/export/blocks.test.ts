import { describe, it, expect } from 'vitest';
import { buildBlocks, buildBlocksBlocking, citationText, type Block } from './blocks';
import { fixtureModel } from './exportFixture';
import { REPORT_FOOTER } from '../analysis/reportModel';

const headings = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { kind: 'heading' }> => b.kind === 'heading').map((b) => b.text);
const toc = (blocks: Block[]) => (blocks.find((b) => b.kind === 'toc') as Extract<Block, { kind: 'toc' }>).entries;
const allText = (blocks: Block[]) =>
  blocks
    .map((b) => {
      switch (b.kind) {
        case 'title':
        case 'paragraph':
        case 'heading':
        case 'footer':
          return b.text;
        case 'meta':
          return b.rows.map((r) => `${r.label} ${r.value}`).join(' | ');
        case 'toc':
          return b.entries.map((e) => `${e.number} ${e.title}`).join(' | ');
        case 'bullets':
          return b.items.join(' | ');
        case 'table':
          return [b.columns.join(' '), ...b.rows.map((r) => r.join(' '))].join(' | ');
      }
    })
    .join('\n');

describe('export blocks', () => {
  it('has the title block with every metadata row, in order', () => {
    const blocks = buildBlocksBlocking(fixtureModel());
    const meta = blocks[1] as Extract<Block, { kind: 'meta' }>;
    expect((blocks[0] as Extract<Block, { kind: 'title' }>).text).toBe('Deep Analysis Report');
    expect(meta.rows.map((r) => r.label)).toEqual(['Matter', 'Document', 'Review date', 'Detail level', 'Focus', 'Reviewing for']);
    expect(meta.rows.find((r) => r.label === 'Reviewing for')?.value).toBe('Licensee');
  });

  it('numbers sections without Prompt Result as 1 to 8, in screen order', () => {
    const blocks = buildBlocksBlocking(fixtureModel());
    expect(toc(blocks).map((e) => `${e.number}. ${e.title}`)).toEqual([
      '1. Overview',
      '2. Clause Breakdown',
      '3. Dates and Amounts',
      '4. Obligations by Party',
      '5. Timeline',
      '6. Risk Register',
      '7. Internal Inconsistencies',
      '8. Coverage',
    ]);
  });

  it('numbers sections with Prompt Result as 1 to 9, and never includes Defined Terms', () => {
    const blocks = buildBlocksBlocking(fixtureModel({ withPrompt: true }));
    expect(toc(blocks).map((e) => `${e.number}. ${e.title}`)).toEqual([
      '1. Overview',
      '2. Prompt Result',
      '3. Clause Breakdown',
      '4. Dates and Amounts',
      '5. Obligations by Party',
      '6. Timeline',
      '7. Risk Register',
      '8. Internal Inconsistencies',
      '9. Coverage',
    ]);
    expect(allText(blocks)).not.toMatch(/Defined Terms/);
  });

  it('keeps every section heading in the order of the table of contents', () => {
    const blocks = buildBlocksBlocking(fixtureModel());
    const sectionHeads = blocks
      .filter((b): b is Extract<Block, { kind: 'heading' }> => b.kind === 'heading' && b.level === 2)
      .filter((h) => /^\d+\. /.test(h.text))
      .map((h) => h.text);
    expect(sectionHeads).toEqual(toc(blocks).map((e) => `${e.number}. ${e.title}`));
  });

  it('includes the clause table rows, verified quotes and model-written labels', () => {
    const blocks = buildBlocksBlocking(fixtureModel({ clauses: 1 }));
    const text = allText(blocks);
    expect(text).toMatch(/Field/);
    expect(text).toMatch(/Section/);
    expect(text).toMatch(/Clause 1 · payment terms/);
    expect(text).toMatch(/Summary \(model-written\)/);
    expect(text).toMatch(/“verified quote 1” — Clause 1 · p\. 1/);
    expect(text).not.toMatch(/Defined Terms/);
  });

  it('includes the Risk Register and the Missing clauses list', () => {
    const text = allText(buildBlocksBlocking(fixtureModel()));
    expect(text).toMatch(/Missing clauses and protections/);
    expect(text).toMatch(/governing law: No governing law or forum is named\./);
    expect(text).toMatch(/Suggested next steps/);
  });

  it('ends with the lawyer-review footer, exactly once', () => {
    const blocks = buildBlocksBlocking(fixtureModel());
    const footers = blocks.filter((b) => b.kind === 'footer');
    expect(footers).toHaveLength(1);
    expect((footers[0] as Extract<Block, { kind: 'footer' }>).text).toBe(REPORT_FOOTER);
    expect(blocks[blocks.length - 1].kind).toBe('footer');
  });

  it('writes citations as plain text "Clause N · p. X"', () => {
    expect(citationText({ clause: '7', page: 12, quote: 'q' })).toBe('Clause 7 · p. 12');
  });

  it('builds the same blocks asynchronously, yielding for large reports', async () => {
    const model = fixtureModel({ clauses: 45 });
    const seen: number[] = [];
    const asyncBlocks = await buildBlocks(model, { onProgress: (d) => seen.push(d), yieldEvery: 10 });
    expect(asyncBlocks).toEqual(buildBlocksBlocking(model));
    expect(seen.length).toBeGreaterThan(1);
  });
});
