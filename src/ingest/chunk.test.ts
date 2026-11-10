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
import { checkChunks } from './checkChunks';

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
    expect(classifyLine('2) Appointment, Scope of work.')).toEqual({ kind: 'clause', no: '2' });
    // (N) is a sub-item inside a clause, not a clause boundary.
    expect(classifyLine('(1) Each party shall comply.')).toBeNull();
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
    topClause: '5',
    startKind: 'clause',
    heading: '5. Huge clause',
    section: 'Article 2',
    pageStart: 3,
    pageEnd: 4,
    text: `5. Huge clause\n${longBody}`,
    gap: null,
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

describe('top-level clause sequence', () => {
  const clauseNos = (text: string) => buildUnits([{ pageNo: 1, text }]).filter((u) => u.startKind === 'clause').map((u) => u.clauseNo);

  it('accepts N) when it continues the sequence, rejects when it jumps backwards', () => {
    const text = '1) One\nbody\n2) Two\nbody\n57) Not a clause\nbody\n3) Three\nbody';
    expect(clauseNos(text)).toEqual(['1', '2', '3']);
  });

  it('accepts a small forward gap and flags it', () => {
    const units = buildUnits([{ pageNo: 1, text: '1) One\nbody\n4) Four\nbody' }]);
    expect(units.map((u) => u.clauseNo)).toEqual(['1', '4']);
    expect(units[1].gap).toBe('2-3');
  });

  it('rejects a large forward jump and keeps going from the real sequence', () => {
    const text = '1) One\nbody\n9) Bogus\nbody\n2) Two\nbody';
    expect(clauseNos(text)).toEqual(['1', '2']);
  });

  it('rejects a restarted sub-item like 2) inside clause 30', () => {
    const text = '30) Obligations\nbody\n2) Mr. Mayuresh Keni shall continue\nmore\n31) Next\nbody';
    expect(clauseNos(text)).toEqual(['30', '31']);
  });

  it('keeps (a), (i), a) and (1) inside the current clause', () => {
    const text = '5) Clause\n(a) sub one\n(i) sub two\na) sub three\n(1) sub four\nmore body\n6) Next';
    const units = buildUnits([{ pageNo: 1, text }]);
    expect(units.filter((u) => u.clauseNo).map((u) => u.clauseNo)).toEqual(['5', '6']);
    expect(units[0].text).toContain('(a) sub one');
    expect(units[0].text).toContain('(1) sub four');
  });
});

describe('table rows are never clauses', () => {
  it('rejects numbered name rows and bare numbered rows without a marker', () => {
    const text = [
      '1) Obligations of the Developer',
      'Some prose that is long enough to read as a sentence.',
      '2. Mr. Someone',
      '3. Mrs. Someone Else',
      '5 After expiry of 2 years there is escalation',
      '2) Next clause',
      'prose',
    ].join('\n');
    const units = buildUnits([{ pageNo: 1, text }]);
    expect(units.filter((u) => u.startKind === 'clause').map((u) => u.clauseNo)).toEqual(['1', '2']);
  });

  it('rejects a row that would otherwise continue the sequence, after a Sr. / no. header', () => {
    const text = [
      '16) Payments',
      'prose here that is long enough to look like a clause body sentence.',
      'Sr.',
      'no.',
      '17. Mr. A Rs. 100',
      '18. Mr. B Rs. 200',
      '19) Next real clause',
      'prose',
    ].join('\n');
    const units = buildUnits([{ pageNo: 1, text }]);
    expect(units.filter((u) => u.startKind === 'clause').map((u) => u.clauseNo)).toEqual(['16', '19']);
  });

  it('keeps table text inside the clause instead of dropping it', () => {
    const text = '16) Payments\nprose\nSr.\nno.\n17. Mr. A Rs. 100\n18) Done';
    const units = buildUnits([{ pageNo: 1, text }]);
    expect(units[0].text).toContain('17. Mr. A Rs. 100');
  });
});

describe('lettered recitals', () => {
  it('accepts A..H, one restart at A, then continues', () => {
    const text = 'A. one\nB. two\nC. three\nA. restart\nB. again\nC. again\nD. end';
    const units = buildUnits([{ pageNo: 1, text }]);
    expect(units.filter((u) => u.startKind === 'lettered').length).toBe(7);
  });

  it('allows only one restart', () => {
    const text = 'A. one\nB. two\nA. r1\nB. again\nA. r2\nB. more';
    const units = buildUnits([{ pageNo: 1, text }]);
    expect(units.filter((u) => u.startKind === 'lettered').length).toBe(4);
  });

  it('rejects a letter that does not follow the previous one', () => {
    const text = 'A. one\nC. skipped\nB. two';
    expect(buildUnits([{ pageNo: 1, text }]).filter((u) => u.startKind === 'lettered').length).toBe(2);
  });
});

describe('checkChunks', () => {
  const pages = pagesFrom(clauseLines(1, 40, 300), 10);
  const chunks = chunkDocument(pages);

  it('passes on a clean set of chunks', () => {
    const r = checkChunks(chunks, pages);
    expect(r.counts.gaps).toBe(0);
    expect(r.counts.overlaps).toBe(0);
    expect(r.counts.aboveMax).toBe(0);
    expect(r.counts.badStarts).toBe(0);
    expect(r.counts.missing).toBe(0);
    expect(r.counts.repeated).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.coveredPages).toBe(r.pageCount);
  });

  it('reports an uncovered page', () => {
    const r = checkChunks(chunks.slice(1), pages);
    expect(r.pageGaps.length).toBeGreaterThan(0);
    expect(r.ok).toBe(false);
  });

  it('reports a real page overlap but allows a shared boundary page', () => {
    const shifted = chunks.map((c, i) => (i === 1 ? { ...c, pageStart: Math.max(1, c.pageStart - 2) } : c));
    const r = checkChunks(shifted, pages);
    expect(r.pageOverlaps.length).toBeGreaterThan(0);
  });

  it('reports a chunk above the max', () => {
    const r = checkChunks(chunks, pages, { ...DEFAULT_CHUNK_CONFIG, maxTokens: 10 });
    expect(r.aboveMax.length).toBe(chunks.length);
  });

  it('reports missing clause numbers', () => {
    const middle = Math.floor(chunks.length / 2);
    const withoutMiddle = chunks.filter((_, i) => i !== middle);
    const r = checkChunks(withoutMiddle, pages);
    expect(r.missingClauses.length).toBeGreaterThan(0);
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
