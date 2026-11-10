import { describe, it, expect } from 'vitest';
import golden from './hiramoti.json';
import { extractPages, findPdf } from './extract';
import { chunkDocument, classifyLine } from '../../src/ingest/chunk';
import { checkChunks } from '../../src/ingest/checkChunks';

const pdfPath = findPdf();

describe('golden: HIRAMOTI NAGAR CHSL DA', () => {
  it.skipIf(!pdfPath)('detects clauses 1-59 with the golden first pages', async () => {
    const pages = await extractPages(pdfPath!);
    expect(pages.length).toBe(golden.pages);

    const chunks = chunkDocument(pages);
    const check = checkChunks(chunks, pages);

    const firstPage = new Map<string, number>();
    for (const c of chunks) {
      for (const clause of c.clauses) {
        if (!firstPage.has(clause)) firstPage.set(clause, c.pageStart);
      }
    }

    for (const [clause, expected] of Object.entries(golden.expectedClauseFirstPage)) {
      const actual = firstPage.get(clause);
      expect(actual, `clause ${clause}`).toBeDefined();
      expect(Math.abs(actual! - expected), `clause ${clause}: got page ${actual}, expected ${expected}`).toBeLessThanOrEqual(golden.tolerance);
    }

    // Clauses 1..59 in order, no gaps.
    const present = [...firstPage.keys()].filter((c) => /^\d+$/.test(c)).map(Number).sort((a, b) => a - b);
    expect(present).toEqual(Array.from({ length: 59 }, (_, i) => i + 1));

    // Every chunk starts on a clause line (except the preamble chunk and size-split parts).
    for (const c of chunks) {
      if (c.index === 0 || c.split) continue;
      expect(classifyLine(c.text.split('\n')[0]), `chunk ${c.index} starts mid-clause`).not.toBeNull();
    }

    // The recital "V." must not stretch past the recitals, and the rent-table row is not a clause.
    for (const c of chunks) {
      if ((c.heading ?? '').startsWith('V.')) expect(c.pageStart).toBeLessThanOrEqual(10);
      expect(c.heading ?? '').not.toMatch(/^5 After expiry/);
      expect(c.clauseFrom ?? '').not.toMatch(/^5 After expiry/);
    }

    // Chunk check: no gaps, no overlaps, no bad starts, no missing or repeated clauses.
    expect(check.pageGaps).toEqual([]);
    expect(check.pageOverlaps).toEqual([]);
    expect(check.missingClauses).toEqual([]);
    expect(check.repeatedClauses).toEqual([]);
    expect(check.badStarts).toEqual([]);
    expect(check.aboveMax).toEqual([]);
    expect(check.ok).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `golden ok: ${chunks.length} chunks, ${check.coveredPages}/${check.pageCount} pages covered, ` +
        `split-by-size ${check.splitClauses.map((s) => s.clause).join(',') || 'none'}`,
    );
  }, 120_000);
});
