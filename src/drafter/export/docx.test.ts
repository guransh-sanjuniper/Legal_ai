import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { assemble } from '../assemble';
import { buildDraftDocx, blocksToDocxChildren } from './docx';
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
