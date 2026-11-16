import { describe, expect, it } from 'vitest';
import { assemble, draftFileName, exportGate } from './assemble';
import { itemFingerprint } from './write';
import type { ClauseRecord, DraftRecord, OutlineItem, SourcePlan } from './types';

function item(id: string, over: Partial<OutlineItem> = {}): OutlineItem {
  return { id, level: 1, title: 'Section', purpose: '', kind: 'clause', bindingIds: [], ...over };
}

function clause(over: Partial<ClauseRecord> = {}): ClauseRecord {
  return {
    text: 'Text.',
    status: 'done',
    itemFingerprint: 'fp',
    sourceBindingIds: [],
    model: 'm',
    generatedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
    ...over,
  };
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

function draftWith(
  items: OutlineItem[],
  clauses: Record<string, ClauseRecord> = {},
  over: Partial<DraftRecord> = {},
): DraftRecord {
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
    ...over,
  };
}

// Builds a draft whose clause fingerprints match the items, so nothing is stale by accident.
function withClauses(
  items: OutlineItem[],
  texts: Record<string, Partial<ClauseRecord>>,
  over: Partial<DraftRecord> = {},
): DraftRecord {
  const base = draftWith(items, {}, over);
  const clauses: Record<string, ClauseRecord> = {};
  for (const [id, over] of Object.entries(texts)) {
    const outlineItem = items.find((candidate) => candidate.id === id);
    if (!outlineItem) throw new Error(`unknown item ${id}`);
    clauses[id] = clause({ itemFingerprint: itemFingerprint(outlineItem, base), ...over });
  }
  return { ...base, clauses };
}

describe('draft assembly', () => {
  it('numbers headings from the outline and leaves unnumbered kinds blank', () => {
    const items = [
      item('i1', { title: 'Parties', kind: 'preamble' }),
      item('i2', { title: 'Grant' }),
      item('i3', { title: 'Term', level: 2 }),
      item('i4', { title: 'Annexure', kind: 'schedule' }),
      item('i5', { title: 'Signature', kind: 'signature' }),
    ];
    const draft = withClauses(items, {
      i1: { text: 'A' },
      i2: { text: 'B' },
      i3: { text: 'C' },
      i4: { text: 'D' },
      i5: { text: 'E' },
    });

    const headings = assemble(draft).blocks.filter(
      (block): block is Extract<typeof block, { kind: 'heading' }> => block.kind === 'heading',
    );
    expect(headings.map((heading) => heading.number)).toEqual(['', '1', '1.1', 'Schedule 1', '']);
    expect(headings.map((heading) => heading.text)).toEqual(['Parties', 'Grant', 'Term', 'Annexure', 'Signature']);
  });

  it('replaces reference tokens, using the title for unnumbered sections and flagging unknown ids', () => {
    const items = [
      item('i1', { title: 'Parties' }),
      item('i2', { title: 'Term', level: 2 }),
      item('i3', { title: 'Payment' }),
      item('i4', { title: 'Signature', kind: 'signature' }),
    ];
    const draft = withClauses(items, {
      i1: { text: 'See {{ref:S2}}, {{ref:S4}} and {{ref:S9}}.' },
      i2: { text: 'B' },
      i3: { text: 'C' },
      i4: { text: 'D' },
    });

    const assembled = assemble(draft);
    const paragraph = assembled.blocks.find(
      (block): block is Extract<typeof block, { kind: 'paragraph' }> => block.kind === 'paragraph',
    );
    expect(paragraph?.text).toBe('See 1.1, Signature and [unknown reference].');
    expect(assembled.stats.unknownRefs).toBe(1);
  });

  it('counts placeholders and keeps them in the text', () => {
    const items = [item('i1'), item('i2')];
    const draft = withClauses(items, {
      i1: { text: 'The licensor is [● name].' },
      i2: { text: 'Rent is [● amount] per month.' },
    });
    const assembled = assemble(draft);
    expect(assembled.stats.placeholders).toBe(2);
    expect(JSON.stringify(assembled.blocks)).toContain('[● name]');
  });

  it('turns pipe-separated rows into a table and drops a markdown separator', () => {
    const items = [item('i1')];
    const draft = withClauses(items, {
      i1: { text: 'Item | Amount\n--- | ---\nRent | 50,000\nDeposit | 1,00,000' },
    });
    const table = assemble(draft).blocks.find(
      (block): block is Extract<typeof block, { kind: 'table' }> => block.kind === 'table',
    );
    expect(table).toEqual({
      kind: 'table',
      columns: ['Item', 'Amount'],
      rows: [
        ['Rent', '50,000'],
        ['Deposit', '1,00,000'],
      ],
    });
  });

  it('keeps a single pipe line as a paragraph', () => {
    const draft = withClauses([item('i1')], { i1: { text: 'Rent | 50,000' } });
    const blocks = assemble(draft).blocks;
    expect(blocks.some((block) => block.kind === 'table')).toBe(false);
    expect(blocks.some((block) => block.kind === 'paragraph' && block.text === 'Rent | 50,000')).toBe(true);
  });

  it('counts stale, failed and pending sections', () => {
    const items = [item('i1'), item('i2'), item('i3')];
    const base = draftWith(items, {});
    const draft: DraftRecord = {
      ...base,
      clauses: {
        i1: clause({ itemFingerprint: 'wrong', text: 'x' }),
        i2: clause({ status: 'failed', text: '', itemFingerprint: 'f' }),
      },
    };
    const { stats } = assemble(draft);
    expect(stats.sections).toBe(3);
    expect(stats.staleSections).toBe(1);
    expect(stats.failedSections).toBe(1);
    expect(stats.pendingSections).toBe(1);
  });

  it('writes a heading and no paragraph for an empty lead-in', () => {
    const items = [item('i1', { title: 'Lead-in' })];
    const draft = withClauses(items, { i1: { text: '' } });
    const blocks = assemble(draft).blocks;
    expect(blocks.map((block) => block.kind)).toEqual(['title', 'subtitle', 'heading']);
  });

  it('uses the document type as subtitle only when it differs from the title', () => {
    const items = [item('i1')];
    const draft = withClauses(items, { i1: { text: 'A' } });
    expect(assemble(draft).blocks.some((block) => block.kind === 'subtitle' && block.text === 'lease')).toBe(true);

    const sameTitle = withClauses(items, { i1: { text: 'A' } }, { title: 'lease' });
    expect(assemble(sameTitle).blocks.some((block) => block.kind === 'subtitle')).toBe(false);
  });

  it('includes verbatim text with no extra annotation', () => {
    const items = [item('i1', { title: 'Indemnity' })];
    const draft = withClauses(items, {
      i1: { text: 'The licensee shall indemnify the licensor.', status: 'verbatim' },
    });
    const assembled = assemble(draft);
    const paragraphs = assembled.blocks.filter(
      (block): block is Extract<typeof block, { kind: 'paragraph' }> => block.kind === 'paragraph',
    );
    expect(paragraphs.map((block) => block.text)).toEqual(['The licensee shall indemnify the licensor.']);
    expect(JSON.stringify(assembled.blocks)).not.toMatch(/copied from/i);
  });

  it('blocks export for empty, pending and failed drafts and warns otherwise', () => {
    expect(exportGate({ sections: 0, placeholders: 0, unknownRefs: 0, staleSections: 0, failedSections: 0, pendingSections: 0 })).toMatchObject({
      allowed: false,
    });
    expect(
      exportGate({ sections: 2, placeholders: 0, unknownRefs: 0, staleSections: 0, failedSections: 0, pendingSections: 1 }),
    ).toMatchObject({ allowed: false });
    expect(
      exportGate({ sections: 2, placeholders: 0, unknownRefs: 0, staleSections: 0, failedSections: 1, pendingSections: 0 }),
    ).toMatchObject({ allowed: false });

    const allowed = exportGate({
      sections: 2,
      placeholders: 1,
      unknownRefs: 1,
      staleSections: 1,
      failedSections: 0,
      pendingSections: 0,
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.blockers).toEqual([]);
    expect(allowed.warnings).toHaveLength(3);
  });

  it('builds a safe file name with the date', () => {
    expect(draftFileName({ title: 'Lease: Flat 2/3', sourcePlan: null }, new Date('2026-01-02T00:00:00.000Z'))).toBe(
      'Lease- Flat 2-3 2026-01-02.docx',
    );
    expect(
      draftFileName({ title: '   ', sourcePlan: plan }, new Date('2026-01-02T00:00:00.000Z')),
    ).toBe('lease 2026-01-02.docx');
    expect(draftFileName({ title: '', sourcePlan: null }, new Date('2026-01-02T00:00:00.000Z'))).toBe(
      'Draft 2026-01-02.docx',
    );
  });

  it('handles 150 sections', () => {
    const items = Array.from({ length: 150 }, (_, index) => item(`i${index}`, { title: `Section ${index + 1}` }));
    const draft = draftWith(items, {});
    const assembled = assemble(draft);
    expect(assembled.stats.sections).toBe(150);
    expect(assembled.stats.pendingSections).toBe(150);
    expect(assembled.blocks).toHaveLength(152);
  });
});
