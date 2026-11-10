import { describe, it, expect } from 'vitest';
import {
  buildUnits,
  chunkDocument,
  chunkUnits,
  classifyLine,
  DEFAULT_CHUNK_CONFIG,
  packSentences,
  sentenceSpans,
  type PageText,
  type Unit,
} from './chunk';

const CFG = DEFAULT_CHUNK_CONFIG;
const tokens = (s: string) => Math.ceil(s.length / 4);

function clauseLines(from: number, to: number, bodyChars: number, section?: string): string {
  const lines: string[] = [];
  if (section) lines.push(section);
  const sentence = 'The Developer shall perform the obligation set out here within the agreed period. ';
  for (let i = from; i <= to; i++) {
    const body = sentence.repeat(Math.max(1, Math.ceil(bodyChars / sentence.length))).slice(0, bodyChars);
    lines.push(`${i}. Clause ${i} heading`);
    lines.push(`${i}.1 ${body}`);
  }
  return lines.join('\n');
}

function pagesFrom(text: string, linesPerPage: number): PageText[] {
  const lines = text.split('\n');
  const pages: PageText[] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push({ pageNo: pages.length + 1, text: lines.slice(i, i + linesPerPage).join('\n') });
  }
  return pages;
}

function clauseUnitsInOrder(chunks: { text: string }[]): string[] {
  return chunks.flatMap((c) => c.text.split('\n'))
    .map((l) => classifyLine(l))
    .filter((k): k is { kind: 'clause'; no: string } => k !== null && k.kind === 'clause')
    .map((k) => k.no);
}

// Clause numbers in the order clauseLines writes them: "N" then "N.1" for each N.
function expectedClauseNos(count: number): string[] {
  return Array.from({ length: count }, (_, i) => [String(i + 1), `${i + 1}.1`]).flat();
}

describe('chunk config', () => {
  it('defaults are 1250 target, 2500 max, 300 min', () => {
    expect(DEFAULT_CHUNK_CONFIG).toEqual({ targetTokens: 1250, maxTokens: 2500, minTokens: 300 });
  });

  it('rejects an inconsistent config', () => {
    expect(() => chunkUnits([], { targetTokens: 3000 })).toThrow(/invalid chunk config/);
    expect(() => chunkUnits([], { minTokens: 2000, targetTokens: 1000 })).toThrow(/invalid chunk config/);
  });

  it('accepts overrides', () => {
    const units = buildUnits([{ pageNo: 1, text: clauseLines(1, 40, 400) }]);
    const small = chunkUnits(units, { targetTokens: 400, maxTokens: 800, minTokens: 100 });
    const big = chunkUnits(units, CFG);
    expect(small.length).toBeGreaterThan(big.length);
    expect(Math.max(...small.map((c) => c.tokenEst))).toBeLessThanOrEqual(800);
  });
});

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

describe('chunk sizes', () => {
  const doc = pagesFrom(clauseLines(1, 150, 300), 20);
  const chunks = chunkDocument(doc);

  it('keeps every chunk at or below the hard max', () => {
    for (const c of chunks) expect(c.tokenEst).toBeLessThanOrEqual(CFG.maxTokens);
  });

  it('gives chunks near the target size, not tiny ones', () => {
    for (const c of chunks.slice(0, -1)) {
      expect(c.tokenEst).toBeGreaterThanOrEqual(CFG.minTokens);
      expect(c.tokenEst).toBeGreaterThanOrEqual(Math.floor(CFG.targetTokens * 0.9));
      expect(c.tokenEst).toBeLessThanOrEqual(CFG.targetTokens + 400);
    }
  });

  it('stores a token estimate equal to characters divided by 4 (rounded up)', () => {
    for (const c of chunks) expect(c.tokenEst).toBe(tokens(c.text));
  });

  it('merges many very small clauses so no chunk is below the minimum', () => {
    const tiny = pagesFrom(clauseLines(1, 300, 5), 60);
    const out = chunkDocument(tiny);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out.slice(0, -1)) expect(c.tokenEst).toBeGreaterThanOrEqual(CFG.minTokens);
    expect(clauseUnitsInOrder(out)).toEqual(expectedClauseNos(300));
  });
});

describe('clauses stay whole', () => {
  it('each chunk starts on a clause line and every clause appears once, in order', () => {
    const pages = pagesFrom(clauseLines(1, 120, 350), 15);
    const chunks = chunkDocument(pages);
    for (const c of chunks) expect(classifyLine(c.text.split('\n')[0])).not.toBeNull();
    expect(clauseUnitsInOrder(chunks)).toEqual(expectedClauseNos(120));
    const joined = chunks.map((c) => c.text).join('\n\n');
    const original = pages.map((p) => p.text).join('\n');
    expect(joined.replace(/\s+/g, '')).toBe(original.replace(/\s+/g, ''));
  });

  it('starts a new chunk at a section boundary when the previous part is big enough', () => {
    const a = clauseLines(1, 20, 400, 'Article 1 Scope');
    const b = clauseLines(21, 40, 400, 'Article 2 Payments');
    const chunks = chunkDocument(pagesFrom(`${a}\n${b}`, 500));
    const sectionOf = (c: { text: string }) => c.text.includes('Article 2') ? 'Article 2' : 'Article 1';
    const boundary = chunks.findIndex((c) => c.parentSection === 'Article 2');
    expect(boundary).toBeGreaterThan(0);
    expect(chunks[boundary - 1].text).not.toContain('Article 2');
    expect(sectionOf(chunks[boundary])).toBe('Article 2');
  });

  it('carries the previous clause forward as context', () => {
    const chunks = chunkDocument(pagesFrom(clauseLines(1, 80, 400), 10));
    expect(chunks[0].carried).toBeNull();
    expect(chunks[1].carried).not.toBeNull();
    expect(chunks[0].text.endsWith(chunks[1].carried!)).toBe(true);
  });
});

describe('oversized clause is split at sentence boundaries', () => {
  const longBody = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} of the clause stays intact.`).join(' ');
  const unit: Unit = {
    clauseNo: '5',
    heading: '5. Huge clause',
    section: 'Article 2',
    pageStart: 3,
    pageEnd: 4,
    text: `5. Huge clause\n${longBody}`,
  };

  it('splits it into parts under the max, each marked', () => {
    const chunks = chunkUnits([unit]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.split).toBe(true);
      expect(c.tokenEst).toBeLessThanOrEqual(CFG.maxTokens);
      expect(c.clauseFrom).toBe('5');
      expect(c.clauseTo).toBe('5');
      expect(c.partCount).toBe(chunks.length);
    }
    expect(chunks.map((c) => c.partIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('keeps the text exact when the parts are joined, and cuts only at sentence ends', () => {
    const parts = packSentences(unit.text, CFG.targetTokens);
    expect(parts.join('')).toBe(unit.text);
    for (const p of parts.slice(0, -1)) expect(p.trimEnd().endsWith('.')).toBe(true);
  });

  it('keeps page range, heading and parent section on each part', () => {
    for (const c of chunkUnits([unit])) {
      expect(c.pageStart).toBe(3);
      expect(c.pageEnd).toBe(4);
      expect(c.heading).toBe('5. Huge clause');
      expect(c.parentSection).toBe('Article 2');
    }
  });

  it('sentenceSpans joins back to the input', () => {
    const s = 'One. Two?! Three;  four\nfive. Six';
    expect(sentenceSpans(s).join('')).toBe(s);
  });
});

describe('65-page contract', () => {
  // About 4,500 characters per page of numbered clauses, as in a dense real contract.
  const pages = pagesFrom(clauseLines(1, 800, 280), 24);

  it('gives roughly 40 to 70 chunks, with no clause cut', () => {
    expect(pages.length).toBeGreaterThanOrEqual(60);
    const chunks = chunkDocument(pages);
    expect(chunks.length).toBeGreaterThanOrEqual(40);
    expect(chunks.length).toBeLessThanOrEqual(70);
    for (const c of chunks) expect(classifyLine(c.text.split('\n')[0])).not.toBeNull();
    expect(clauseUnitsInOrder(chunks)).toEqual(expectedClauseNos(800));
  });
});
