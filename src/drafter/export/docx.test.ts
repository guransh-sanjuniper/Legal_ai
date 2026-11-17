import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { assemble, headingLabel, type DraftBlock } from '../assemble';
import { buildDraftDocx, blocksToDocxChildren, formatLongDate, partiesLine } from './docx';
import type { ClauseRecord, DraftRecord, OutlineItem, SourcePlan } from '../types';

// Minimal zip reader for the generated file: local file headers, deflate or stored entries.
function readZipEntry(buf: Buffer, wanted: string): string | null {
  for (let off = 0; off < buf.length - 4; off++) {
    if (buf.readUInt32LE(off) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(off + 8);
    const size = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString();
    const start = off + 30 + nameLen + extraLen;
    if (name === wanted) {
      const data = buf.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    off = start + size - 1;
  }
  return null;
}

const plan: SourcePlan = {
  docType: 'lease',
  summary: 'A lease.',
  lengthHint: null,
  referenceMode: 'none',
  bindings: [],
  unresolved: [],
  questions: [],
  parsedAt: '2026-01-01T00:00:00.000Z',
  model: 'plan-model',
  parsedFrom: { instruction: 'Draft a lease.', referenceDocIds: [] },
};

function item(id: string, over: Partial<OutlineItem> = {}): OutlineItem {
  return { id, level: 1, title: 'Section', purpose: '', kind: 'clause', bindingIds: [], ...over };
}

function clause(text: string): ClauseRecord {
  return {
    text,
    status: 'done',
    itemFingerprint: 'fp',
    sourceBindingIds: [],
    model: 'write-model',
    generatedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 100,
  };
}

function draft(items: OutlineItem[], clauses: Record<string, ClauseRecord>): DraftRecord {
  return {
    id: 'draft-1',
    userId: 'user-a',
    title: 'Residential lease',
    instruction: 'Draft a lease.',
    referenceDocIds: [],
    reviewingFor: 'neutral',
    status: 'done',
    particulars: null,
    sourcePlan: plan,
    outline: {
      items,
      notes: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      model: 'outline-model',
      planFingerprint: 'fp',
    },
    sourceText: null,
    clauses,
    writeRun: null,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function sampleDraft(): DraftRecord {
  const items = [
    item('i1', { title: 'Parties' }),
    item('i2', { title: 'Term', level: 2 }),
    item('i3', { title: 'Payment' }),
  ];
  return draft(items, {
    i1: clause('The licensor is [● name]. The licensee is [● name].'),
    i2: clause('The term is two years.'),
    i3: clause('Item | Amount\nRent | 50,000\nDeposit | 1,00,000'),
  });
}

const plain = (xml: string) => xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const decode = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

// Every character the document shows, in order, with tabs and breaks as spaces.
function documentText(xml: string): string {
  return decode(
    xml
      .replace(/<w:tab\/>/g, ' ')
      .replace(/<w:br[^>]*\/>/g, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// Run boundaries do not carry spaces, so text is compared without any whitespace: a difference
// then means a character was added, dropped or reworded.
const squash = (value: string) => value.replace(/\s+/g, '');

// The same text as the block list would print it, for the "formatting only" comparison.
function blocksText(blocks: DraftBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading') parts.push(headingLabel(block));
    else if (block.kind === 'paragraph' || block.kind === 'title' || block.kind === 'subtitle') {
      parts.push(block.text);
    } else if (block.kind === 'table') {
      parts.push(...block.columns, ...block.rows.flat());
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

interface Run {
  text: string;
  bold: boolean;
}

function runsOf(xml: string): Run[] {
  const out: Run[] = [];
  for (const match of xml.matchAll(/<w:r>(.*?)<\/w:r>/gs)) {
    const body = match[1];
    const text = [...body.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gs)].map((part) => decode(part[1])).join('');
    out.push({ text, bold: /<w:b\/>/.test(body) });
  }
  return out;
}

async function buildXml(draft: DraftRecord, now = new Date(2026, 10, 17)) {
  const assembled = assemble(draft);
  const blob = await buildDraftDocx(assembled.blocks, { now });
  const buf = Buffer.from(await blob.arrayBuffer());
  const xml = readZipEntry(buf, 'word/document.xml');
  if (xml === null) throw new Error('word/document.xml missing');
  return { assembled, buf, xml };
}

function sectionDraft(level1: number, level2 = 0, kinds: Partial<OutlineItem> = {}): DraftRecord {
  const items: OutlineItem[] = [];
  const clauses: Record<string, ClauseRecord> = {};
  for (let index = 0; index < level1; index++) {
    const id = `a${index}`;
    items.push(item(id, { title: `Section ${index + 1}`, ...kinds }));
    clauses[id] = clause(`Body ${index + 1}.`);
  }
  for (let index = 0; index < level2; index++) {
    const id = `b${index}`;
    items.push(item(id, { title: `Detail ${index + 1}`, level: 2 }));
    clauses[id] = clause(`Detail body ${index + 1}.`);
  }
  return draft(items, clauses);
}

describe('drafter DOCX export', () => {
  it('builds headings, tables, the title and highlighted placeholders', async () => {
    const assembled = assemble(sampleDraft());
    const blob = await buildDraftDocx(assembled.blocks);
    const xml = readZipEntry(Buffer.from(await blob.arrayBuffer()), 'word/document.xml');
    if (xml === null) throw new Error('word/document.xml missing');

    expect(xml).toMatch(/Heading1/);
    expect(xml).toMatch(/Heading2/);
    expect(xml).toMatch(/<w:tbl>/);
    expect(xml).toMatch(/<w:highlight w:val="yellow"\/>/);

    const text = plain(xml);
    expect(text).toMatch(/Residential lease/);
    expect(text).toMatch(/1 Parties/);
    expect(text).toMatch(/1\.1 Term/);
    expect(text).toMatch(/Rent/);
    expect(text).toMatch(/\[● name\]/);
  });

  it('uses the built-in heading styles and the review footer with page numbers', async () => {
    const children = blocksToDocxChildren(assemble(sampleDraft()).blocks);
    expect(JSON.stringify(children)).toMatch(/Heading1|Heading2/);

    const blob = await buildDraftDocx(assemble(sampleDraft()).blocks);
    const buf = Buffer.from(await blob.arrayBuffer());
    const footerXml = (() => {
      for (const name of ['word/footer1.xml', 'word/footer2.xml']) {
        const found = readZipEntry(buf, name);
        if (found) return found;
      }
      return null;
    })();
    expect(footerXml).toBeTruthy();
    expect(plain(footerXml!)).toMatch(/AI-assisted, requires lawyer review/);
    expect(footerXml).toMatch(/PAGE/);
  });

  it('builds a large document without error', async () => {
    const items = Array.from({ length: 150 }, (_, index) => item(`i${index}`, { title: `Section ${index + 1}` }));
    const clauses: Record<string, ClauseRecord> = {};
    for (const outlineItem of items) clauses[outlineItem.id] = clause('Section text.');
    const assembled = assemble(draft(items, clauses));
    const blob = await buildDraftDocx(assembled.blocks);
    expect(blob.size).toBeGreaterThan(1000);
  });
});

// ---------- D6.1 layout ----------

function coverDraft(): DraftRecord {
  const items: OutlineItem[] = [item('p', { title: 'Parties', kind: 'preamble' })];
  const clauses: Record<string, ClauseRecord> = {
    p: clause('This agreement is made between Alpha Holdings Ltd and Beta Estates Pvt Ltd.'),
  };
  for (let index = 0; index < 19; index++) {
    items.push(item(`c${index}`, { title: `Clause ${index + 1}` }));
    clauses[`c${index}`] = clause(`Clause body ${index + 1}.`);
  }
  return draft(items, clauses);
}

describe('drafter DOCX layout', () => {
  it('stays plain for a short draft: no cover, no contents, no page breaks', async () => {
    const { buf, xml } = await buildXml(sampleDraft());

    expect(xml).not.toMatch(/TOC \\h/);
    expect(xml).not.toMatch(/<w:pageBreakBefore\/>/);
    expect(xml).not.toMatch(/<w:titlePg/);
    expect(readZipEntry(buf, 'word/header2.xml')).toBeNull();

    const header = readZipEntry(buf, 'word/header1.xml');
    expect(header).toBeTruthy();
    expect(plain(header!)).toContain('Residential lease');
  });

  it('adds a cover page and a contents page from 15 level-1 sections', async () => {
    const { buf, xml } = await buildXml(coverDraft());

    expect(xml).toMatch(/TOC \\h/);
    expect(xml).toMatch(/TOC1/);
    expect(xml).toMatch(/<w:titlePg\/>/);
    expect((xml.match(/<w:pageBreakBefore\/>/g) ?? []).length).toBeGreaterThanOrEqual(2);

    const text = documentText(xml);
    expect(text).toContain('Residential lease');
    expect(text).toContain('between Alpha Holdings Ltd and Beta Estates Pvt Ltd');
    expect(text).toContain('17 November 2026');
    // The cover carries the title, so the body does not repeat it.
    expect(text.match(/Residential lease/g)?.length).toBe(1);

    const settings = readZipEntry(buf, 'word/settings.xml');
    expect(settings).toMatch(/<w:updateFields\/>/);
  });

  it('does not count level-2 sections towards the cover threshold', async () => {
    const short = await buildXml(sectionDraft(10, 8));
    expect(short.xml).not.toMatch(/TOC \\h/);
    expect(short.xml).not.toMatch(/<w:titlePg/);

    const long = await buildXml(sectionDraft(15));
    expect(long.xml).toMatch(/TOC \\h/);
    expect(long.xml).toMatch(/<w:titlePg\/>/);
  });

  it('starts a schedule on a new page and drops a number the title repeats', async () => {
    const items = [
      item('s1', { title: 'Grant' }),
      item('s2', { title: 'Schedule 1 - Floor Plans', kind: 'schedule' }),
      item('s3', { title: 'Signature', kind: 'signature' }),
    ];
    const { xml } = await buildXml(
      draft(items, {
        s1: clause('Grant body.'),
        s2: clause('Floor plan body.'),
        s3: clause('Signed by the parties.'),
      }),
    );

    expect(xml).toMatch(/<w:pageBreakBefore\/>/);
    expect(plain(xml)).toContain('Schedule 1 Floor Plans');
    expect(plain(xml)).not.toContain('Schedule 1 - Floor Plans');
  });

  it('repeats a table header row across pages and shades it', async () => {
    const { xml } = await buildXml(sampleDraft());
    expect(xml).toMatch(/<w:tblHeader\/>/);
    expect(xml).toMatch(/<w:shd[^>]*w:fill="F2F2F2"/);
  });

  it('indents (a) and (i) paragraphs and leaves a plain paragraph alone', async () => {
    const { xml } = await buildXml(
      draft([item('i1')], { i1: clause('(a) first item\n(i) sub item\n(ii) second sub item\n(b) second item') }),
    );
    expect(xml).toContain('<w:ind w:left="720" w:hanging="360"/>');
    expect(xml).toContain('<w:ind w:left="1440" w:hanging="360"/>');

    const plainChildren = blocksToDocxChildren([{ kind: 'paragraph', text: 'Just one plain sentence.' }]);
    expect(JSON.stringify(plainChildren)).not.toMatch(/indent/);
  });

  it('bolds a defined term without changing the text', async () => {
    const text = 'The "Licensor" means Alpha Holdings Ltd. (the "Premises") is the flat at [● address].';
    const { assembled, xml } = await buildXml(draft([item('i1')], { i1: clause(text) }));

    const runs = runsOf(xml);
    expect(runs.some((run) => run.text === '"Licensor"' && run.bold)).toBe(true);
    expect(runs.some((run) => run.text === '"Premises"' && run.bold)).toBe(true);
    expect(runs.some((run) => run.text.includes('means') && run.bold)).toBe(false);

    expect(squash(documentText(xml))).toBe(squash(blocksText(assembled.blocks)));
    expect(xml).toMatch(/<w:highlight w:val="yellow"\/>/);
  });

  it('lays out a signature block as a borderless table', async () => {
    const text = 'Licensor: [● name] ____\nLicensee: [● name] ____';
    const { xml } = await buildXml(draft([item('i1', { title: 'Signature', kind: 'signature' })], { i1: clause(text) }));

    expect(xml).toMatch(/<w:tbl>/);
    expect((xml.match(/<w:tc>/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(xml).toMatch(/<w:tblBorders>/);
    expect(xml).toMatch(/<w:highlight w:val="yellow"\/>/);

    const shown = plain(xml);
    expect(shown).toContain('Licensor:');
    expect(shown).toContain('Licensee:');
    expect(shown).toContain('[● name]');
    expect(shown).toContain('____');
  });

  it('falls back to paragraphs when the signature text does not match', async () => {
    const text = 'Signed by the parties on the date above.';
    const { xml } = await buildXml(
      draft([item('i1', { title: 'Signature', kind: 'signature' })], { i1: clause(text) }),
    );
    expect(xml).not.toMatch(/<w:tbl>/);
    expect(plain(xml)).toContain(text);
  });

  it('puts the title in the header and keeps the review footer', async () => {
    const { buf, xml } = await buildXml(coverDraft());
    expect(xml).toMatch(/<w:titlePg\/>/);

    const header = readZipEntry(buf, 'word/header1.xml');
    expect(plain(header!)).toContain('Residential lease');

    const firstHeader = readZipEntry(buf, 'word/header2.xml');
    expect(firstHeader).toBeTruthy();
    expect(plain(firstHeader!)).toBe('');

    const footer = readZipEntry(buf, 'word/footer1.xml');
    expect(plain(footer!)).toContain('AI-assisted, requires lawyer review');
    expect(footer!).toMatch(/PAGE/);
    expect(footer!).toMatch(/NUMPAGES/);

    const firstFooter = readZipEntry(buf, 'word/footer2.xml');
    expect(firstFooter).toBeTruthy();
    expect(plain(firstFooter!)).toBe('');
  });

  it('reads the parties line from the preamble only when it is a recognisable one', () => {
    const blocks: DraftBlock[] = [
      { kind: 'heading', level: 1, number: '', text: 'Parties', sectionKind: 'preamble' },
      { kind: 'paragraph', text: 'This agreement is made between Alpha Holdings Ltd and Beta Estates Pvt Ltd.' },
      { kind: 'heading', level: 1, number: '1', text: 'Grant', sectionKind: 'clause' },
    ];
    expect(partiesLine(blocks)).toBe('between Alpha Holdings Ltd and Beta Estates Pvt Ltd');

    expect(
      partiesLine([
        { kind: 'heading', level: 1, number: '', text: 'Parties', sectionKind: 'preamble' },
        { kind: 'paragraph', text: 'This deed is made by the parties.' },
      ]),
    ).toBe('');

    // No preamble section: no parties line, even if a body paragraph says "between".
    expect(
      partiesLine([{ kind: 'paragraph', text: 'Rent is paid between the first and the fifth day.' }]),
    ).toBe('');

    expect(formatLongDate(new Date(2026, 10, 17))).toBe('17 November 2026');
  });
});
