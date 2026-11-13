import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { Packer } from 'docx';
import { buildBlocksBlocking } from './blocks';
import { buildDocx, blocksToDocxChildren } from './docx';
import { fixtureModel } from './exportFixture';

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

async function docXml(withPrompt: boolean): Promise<string> {
  const blocks = buildBlocksBlocking(fixtureModel({ withPrompt, clauses: 2 }));
  const blob = await buildDocx(blocks);
  const xml = readZipEntry(Buffer.from(await blob.arrayBuffer()), 'word/document.xml');
  if (xml === null) throw new Error('word/document.xml missing');
  return xml;
}

const plain = (xml: string) => xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('DOCX export', () => {
  it('contains every section in order without Prompt Result', async () => {
    const text = plain(await docXml(false));
    const titles = ['Overview', 'Clause Breakdown', 'Dates and Amounts', 'Obligations by Party', 'Timeline', 'Risk Register', 'Internal Inconsistencies', 'Coverage'];
    let at = -1;
    for (const [i, title] of titles.entries()) {
      const found = text.indexOf(`${i + 1}. ${title}`, at + 1);
      expect(found, `${i + 1}. ${title}`).toBeGreaterThan(at);
      at = found;
    }
    expect(text).not.toMatch(/Defined Terms/);
    expect(text).not.toMatch(/Prompt Result/);
  });

  it('adds Prompt Result as section 2 and renumbers the rest', async () => {
    const text = plain(await docXml(true));
    const order = ['1. Overview', '2. Prompt Result', '3. Clause Breakdown', '4. Dates and Amounts', '9. Coverage'];
    let at = -1;
    for (const title of order) {
      const found = text.indexOf(title, at + 1);
      expect(found, title).toBeGreaterThan(at);
      at = found;
    }
  });

  it('has real tables and the Missing list', async () => {
    const xml = await docXml(false);
    expect((xml.match(/<w:tbl>/g) ?? []).length).toBeGreaterThan(4);
    const text = plain(xml);
    expect(text).toMatch(/Missing clauses and protections/);
    expect(text).toMatch(/governing law: No governing law or forum is named/);
  });

  it('uses the built-in heading styles and a page-number footer', async () => {
    const blocks = buildBlocksBlocking(fixtureModel());
    const children = blocksToDocxChildren(blocks);
    expect(JSON.stringify(children)).toMatch(/Heading1|Heading2/);
    const blob = await buildDocx(blocks);
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
    expect(await Packer.toBuffer(await buildDocxBufferDoc())).toBeTruthy();
  });

  it('renders citations as plain text', async () => {
    expect(plain(await docXml(false))).toMatch(/Clause 1 · p\. 1/);
  });
});

// Helper for the binary smoke check: the same document without a Blob round trip.
async function buildDocxBufferDoc() {
  const { Document } = await import('docx');
  return new Document({ sections: [{ children: blocksToDocxChildren(buildBlocksBlocking(fixtureModel())) }] });
}
