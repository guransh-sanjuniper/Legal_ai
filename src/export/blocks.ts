import {
  LAW_LABEL,
  NOT_STATED,
  REPORT_FOOTER,
  type Citation,
  type ClauseView,
  type ReportModel,
  type ReportSection,
  type RiskRow,
} from '../analysis/reportModel';

// Export blocks: the single content description that both the DOCX and the HTML writers render.
// It is built only from ReportModel, so the exports match the screen section for section.

export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'meta'; rows: { label: string; value: string }[] }
  | { kind: 'toc'; entries: { number: number; title: string }[] }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string; muted?: boolean }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'footer'; text: string };

export const CITATION_LABEL = 'Clause';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Citations are plain text in both exports: "Clause N · p. X".
export function citationText(c: Citation): string {
  return `${CITATION_LABEL} ${c.clause} · p. ${c.page}`;
}

const withCitation = (text: string, c?: Citation) => (c ? `${text} (${citationText(c)})` : text);
const orNotStated = (s: string | null | undefined) => (s && s.trim() ? s.trim() : NOT_STATED);

function rangeLabel(start: number, end: number): string {
  return start === end ? `page ${start}` : `pages ${start}–${end}`;
}

function clauseTable(clause: ClauseView): Block {
  const risk = clause.topPriority ? `${cap(clause.topPriority)} · ${clause.riskCount} risk(s)` : 'None identified';
  const rows: string[][] = [
    ['Section', `Clause ${clause.clauseNo}${clause.type ? ` · ${clause.type}` : ''}`],
    ['Pages', rangeLabel(clause.pageStart, clause.pageEnd)],
    ['Risk', risk],
  ];
  for (const r of clause.rows) {
    const label = r.modelWritten ? `${r.label} (model-written)` : r.label;
    if (r.label === 'Quoted text') {
      rows.push([label, r.citations.length ? r.citations.map((c) => `“${c.quote}” — ${citationText(c)}`).join('\n') : NOT_STATED]);
    } else if (r.items.length > 0) {
      const items = r.items.map((item, i) => withCitation(item, r.citations[i]));
      const note = r.label === 'Law references' ? `\nLabelled ${LAW_LABEL}.` : '';
      rows.push([label, items.join('\n') + note]);
    } else {
      rows.push([label, orNotStated(r.text)]);
    }
  }
  return { kind: 'table', columns: ['Field', 'Detail'], rows };
}

function riskTable(rows: RiskRow[]): Block {
  return {
    kind: 'table',
    columns: ['#', 'Level', 'Clause and page', 'Affects', 'Issue', 'Law references', 'Suggested next steps'],
    rows: rows.map((r, i) => [
      String(i + 1),
      cap(r.priority),
      `${r.clause}${r.pages ? ` · ${r.pages}` : ''}`,
      r.affects,
      r.issue,
      r.laws.length ? `${r.laws.join('; ')}\n(${LAW_LABEL})` : 'None named',
      r.suggestion,
    ]),
  };
}

function sectionBlocks(section: ReportSection, model: ReportModel): Block[] {
  const heading: Block = { kind: 'heading', level: 2, text: `${section.number}. ${section.title}` };
  const out: Block[] = [heading];

  switch (section.key) {
    case 'overview':
      section.points.forEach((p, i) => {
        out.push({ kind: 'heading', level: 3, text: `${i + 1}. ${p.title}` });
        if (p.note) out.push({ kind: 'paragraph', text: p.note, muted: true });
        if (p.sentences.length === 0) {
          out.push({ kind: 'paragraph', text: NOT_STATED, muted: true });
          return;
        }
        out.push({
          kind: 'bullets',
          items: p.sentences.map((s) => {
            const cites = s.citations.map(citationText).join('; ');
            return cites ? `${s.text} (${cites})` : s.text;
          }),
        });
      });
      return out;

    case 'promptResult': {
      out.push({ kind: 'paragraph', text: `Prompt: “${section.prompt}”`, muted: true });
      if (section.answer.length === 0) {
        out.push({ kind: 'paragraph', text: 'Not found in this document.', muted: true });
      } else {
        out.push({
          kind: 'paragraph',
          text: section.answer.map((a) => a.text).join(' '),
        });
      }
      if (section.groups.length > 0) {
        out.push({ kind: 'heading', level: 3, text: 'Supporting quotes' });
        for (const g of section.groups) {
          out.push({ kind: 'bullets', items: g.quotes.map((q) => `“${q.quote}” (${citationText(q.citation)})`) });
        }
      }
      out.push({
        kind: 'paragraph',
        text: `Chunks answered ${section.chunksDone} of ${section.chunksTotal}.${section.failed.length ? ` Not answered: ${section.failed.join('; ')}.` : ''}`,
        muted: true,
      });
      return out;
    }

    case 'clauses': {
      const m = model.merge;
      out.push({
        kind: 'paragraph',
        text:
          `${m.entries} stored entries → ${m.rows} clause rows. ${m.placed} unnumbered entries placed by their quotes or chunk; ` +
          `${m.merged} merged into another row; ${m.unmerged} kept separate because they could not be placed.`,
        muted: true,
      });
      if (model.clauses.length === 0) out.push({ kind: 'paragraph', text: 'No clauses were analysed.', muted: true });
      for (const c of model.clauses) {
        out.push({ kind: 'heading', level: 3, text: `Clause ${c.clauseNo}${c.type ? ` · ${c.type}` : ''}` });
        out.push(clauseTable(c));
      }
      return out;
    }

    case 'datesAmounts':
      out.push({ kind: 'heading', level: 3, text: 'Dates' });
      if (section.dates.length === 0) {
        out.push({ kind: 'paragraph', text: 'No dates with a stated purpose were found.', muted: true });
      } else {
        out.push({
          kind: 'table',
          columns: ['Date', 'What it is', 'Fixed or relative', 'Clause', 'Source'],
          rows: section.dates.map((r) => [r.date, r.purpose, cap(r.timing), r.clause, citationText(r.citation)]),
        });
      }
      out.push({ kind: 'heading', level: 3, text: 'Amounts' });
      if (section.amounts.length === 0) {
        out.push({ kind: 'paragraph', text: 'No amounts were found.', muted: true });
      } else {
        out.push({
          kind: 'table',
          columns: ['Amount', 'What it is for', 'Payer to payee', 'When due', 'Clause', 'Source'],
          rows: section.amounts.map((r) => [r.amount, r.purpose, r.payerToPayee, r.due, r.clause, citationText(r.citation)]),
        });
      }
      return out;

    case 'obligations':
      if (section.groups.length === 0) {
        out.push({ kind: 'paragraph', text: 'No obligations were found in the verified items.', muted: true });
      }
      for (const g of section.groups) {
        out.push({ kind: 'heading', level: 3, text: g.party });
        out.push({ kind: 'bullets', items: g.rows.map((r) => withCitation(r.text, r.citation)) });
      }
      return out;

    case 'risks':
      if (section.reviewLine) out.push({ kind: 'paragraph', text: section.reviewLine, muted: true });
      out.push({ kind: 'heading', level: 3, text: 'Risks' });
      out.push(riskTable(section.risks));
      out.push({ kind: 'heading', level: 3, text: 'Missing clauses and protections' });
      out.push(riskTable(section.missing));
      return out;

    case 'inconsistencies':
      if (section.findings.length === 0) {
        out.push({ kind: 'paragraph', text: 'No inconsistency was found by the checks.', muted: true });
      } else {
        out.push({
          kind: 'bullets',
          items: section.findings.map((f) => {
            const cites = f.citations.map(citationText).join('; ');
            return cites ? `${f.text} (${cites})` : f.text;
          }),
        });
      }
      return out;

    case 'coverage':
      out.push({ kind: 'bullets', items: section.lines });
      return out;
  }
}

function headBlocks(model: ReportModel): Block[] {
  const blocks: Block[] = [
    { kind: 'title', text: 'Deep Analysis Report' },
    {
      kind: 'meta',
      rows: [
        { label: 'Matter', value: model.title.matter },
        { label: 'Document', value: model.title.document },
        { label: 'Review date', value: model.title.reviewDate },
        { label: 'Detail level', value: model.title.detailLevel },
        { label: 'Focus', value: model.title.focus },
        { label: 'Reviewing for', value: cap(model.title.reviewingFor) },
      ],
    },
  ];
  if (model.banner.length > 0) {
    blocks.push({ kind: 'paragraph', text: `Partial report. ${model.banner.join(' ')}`, muted: true });
  }
  blocks.push({ kind: 'heading', level: 2, text: 'Table of Contents' });
  blocks.push({ kind: 'toc', entries: model.toc.map((t) => ({ number: t.number, title: t.title })) });
  return blocks;
}

// Synchronous build. For large reports use buildBlocks with a progress callback so the page can yield.
export function buildBlocksBlocking(model: ReportModel): Block[] {
  const blocks = headBlocks(model);
  for (const section of model.sections) blocks.push(...sectionBlocks(section, model));
  blocks.push({ kind: 'footer', text: REPORT_FOOTER });
  return blocks;
}

export interface BuildOptions {
  onProgress?: (done: number, total: number) => void;
  // Reports with more clauses than this yield to the UI between clauses.
  yieldEvery?: number;
}

// Yields to the UI thread while the clause tables are built, so a large report does not freeze the page.
export async function buildBlocks(model: ReportModel, opts: BuildOptions = {}): Promise<Block[]> {
  const every = opts.yieldEvery ?? 20;
  const total = model.clauses.length;
  const blocks = headBlocks(model);
  let done = 0;
  for (const section of model.sections) {
    for (const block of sectionBlocks(section, model)) {
      blocks.push(block);
      if (section.key === 'clauses' && block.kind === 'table') {
        done++;
        if (done % every === 0) {
          opts.onProgress?.(done, total);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }
  }
  opts.onProgress?.(total, total);
  blocks.push({ kind: 'footer', text: REPORT_FOOTER });
  return blocks;
}
