import { describe, it, expect } from 'vitest';
import { buildUnits, chunkDocument, classifyLine } from './chunk';

describe('numbering variants', () => {
  it('detects clause, sub-clause, section and schedule lines', () => {
    expect(classifyLine('1. Definitions')).toEqual({ kind: 'clause', no: '1' });
    expect(classifyLine('1.1 Developer means Sunrise.')).toEqual({ kind: 'clause', no: '1.1' });
    expect(classifyLine('3.1.1 First instalment on booking.')).toEqual({ kind: 'clause', no: '3.1.1' });
    expect(classifyLine('Clause 5.2 Stamp duty shall be paid.')).toEqual({ kind: 'clause', no: '5.2' });
    expect(classifyLine('(1) Each party shall comply.')).toEqual({ kind: 'clause', no: '(1)' });
    expect(classifyLine('Article 5 Registration')).toEqual({ kind: 'section', label: 'Article 5' });
    expect(classifyLine('Schedule A Purchaser Details')).toEqual({ kind: 'section', label: 'Schedule A' });
    expect(classifyLine('Annexure II Plan')).toEqual({ kind: 'section', label: 'Annexure II' });
    expect(classifyLine('(a) subject to force majeure;')).toBeNull();
    expect(classifyLine('(i) interest shall be paid.')).toBeNull();
    expect(classifyLine('Rs. 1,25,00,000 payable')).toBeNull();
    expect(classifyLine('2 percent per month')).toBeNull();
  });

  it('builds units with clause numbers, sections and page ranges', () => {
    const pages = [
      { pageNo: 1, text: 'Article 1 Definitions\n1. Definitions\n1.1 Developer means Sunrise.' },
      { pageNo: 2, text: '2. Possession\n2.1 Hand over possession.\n(a) subject to force majeure;\n(b) subject to dues.' },
      { pageNo: 3, text: 'Schedule A Purchaser Details\nName: Asha Kulkarni.' },
    ];
    const units = buildUnits(pages);
    expect(units.map((u) => u.clauseNo)).toEqual([null, '1', '1.1', '2', '2.1', null]);
    const possession21 = units.find((u) => u.clauseNo === '2.1')!;
    expect(possession21.text).toContain('(a) subject to force majeure;');
    expect(possession21.pageStart).toBe(2);
    expect(units[units.length - 1].section).toBe('Schedule A');
    expect(units[2].section).toBe('Article 1');
  });
});

describe('chunking never cuts a clause', () => {
  const makePages = (clauses: number, pageEvery: number) => {
    const pages: { pageNo: number; text: string }[] = [];
    let page = 1;
    let lines: string[] = [];
    for (let i = 1; i <= clauses; i++) {
      const body = `The Developer shall perform obligation ${i} under the agreement. ${'Detail text. '.repeat(25)}(a) first sub item; (b) second sub item.`;
      lines.push(`${i}. Clause ${i} heading`);
      lines.push(body);
      if (i % pageEvery === 0) {
        pages.push({ pageNo: page, text: lines.join('\n') });
        lines = [];
        page++;
      }
    }
    if (lines.length) pages.push({ pageNo: page, text: lines.join('\n') });
    return pages;
  };

  it('splits into several chunks, each starting on a clause boundary, every clause exactly once in order', () => {
    const pages = makePages(60, 4);
    const chunks = chunkDocument(pages, { maxTokens: 1000 });
    expect(chunks.length).toBeGreaterThan(3);

    for (const chunk of chunks) {
      const firstLine = chunk.text.split('\n')[0];
      expect(classifyLine(firstLine)).not.toBeNull();
      expect(chunk.tokenEst).toBeLessThanOrEqual(1000);
      expect(chunk.oversize).toBe(false);
    }

    const clauseNumbers = chunks.flatMap((c) => c.text.split('\n').map((l) => classifyLine(l)))
      .filter((k): k is { kind: 'clause'; no: string } => k !== null && k.kind === 'clause')
      .map((k) => k.no);
    expect(clauseNumbers).toEqual(Array.from({ length: 60 }, (_, i) => String(i + 1)));

    const joined = chunks.map((c) => c.text).join('\n\n');
    const original = pages.map((p) => p.text).join('\n');
    expect(joined.replace(/\s+/g, '')).toBe(original.replace(/\s+/g, ''));
  });

  it('carries the previous clause forward and keeps the page range and clause range', () => {
    const chunks = chunkDocument(makePages(30, 3), { maxTokens: 800 });
    expect(chunks[0].carried).toBeNull();
    expect(chunks[1].carried).toContain('obligation');
    expect(chunks[0].clauseFrom).toBe('1');
    expect(chunks[0].pageStart).toBe(1);
    expect(chunks[chunks.length - 1].clauseTo).toBe('30');
    expect(chunks[chunks.length - 1].pageEnd).toBe(10);
  });

  it('keeps a single oversize clause whole and flags it', () => {
    const big = `5. Huge clause\n${'word '.repeat(10000)}`;
    const chunks = chunkDocument([{ pageNo: 1, text: `1. Short\nshort text here.\n${big}\n6. After\nafter text.` }], { maxTokens: 500 });
    const oversize = chunks.find((c) => c.oversize);
    expect(oversize).toBeDefined();
    expect(oversize!.text.startsWith('5. Huge clause')).toBe(true);
    expect(oversize!.clauseFrom).toBe('5');
  });
});
