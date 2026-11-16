import { describe, it, expect } from 'vitest';
import type { PromptAnswer, PromptResult } from '../analysis/types';
import { MODE_LABEL, chatSources, citationLabel, promptResultContent, savedCitations, savedContent } from './documentAnswer';
import type { SavedRow } from './route';

const ans = (id: string, page: number, clause: string, quote: string): PromptAnswer => ({
  itemId: id,
  text: `text ${id}`,
  clause,
  page,
  quote,
  verified: true,
});

const result = (over: Partial<PromptResult>): PromptResult => ({
  prompt: 'q',
  answers: [],
  chunksTotal: 3,
  chunksDone: 3,
  failedChunks: [],
  ...over,
});

describe('savedContent', () => {
  const rows: SavedRow[] = [{ label: 'Amount: Security deposit', text: 'Rs 50,000', citation: null }];

  it('says the answer came from the saved report with no model call', () => {
    expect(savedContent(rows, 1)).toBe('From the saved analysis report (no model call).\n\n- **Amount: Security deposit**: Rs 50,000');
  });

  it('says how many rows were left out', () => {
    expect(savedContent(rows, 9)).toContain('Showing 1 of 9 matching rows.');
  });

  it('keeps one source per distinct citation', () => {
    const c = { clause: '4', page: 3, quote: 'deposit' };
    expect(savedCitations([...rows, { label: 'b', text: 'b', citation: c }, { label: 'c', text: 'c', citation: { ...c } }]))
      .toEqual([c]);
  });
});

describe('promptResultContent', () => {
  it('shows only the answers the sentences cite', () => {
    const r = result({
      answers: [ans('P1', 3, '4', 'quote one'), ans('P2', 7, '9', 'quote two')],
      answer: [{ text: 'The deposit is refundable.', cites: ['P2'] }],
    });
    const out = promptResultContent(r, { searchFellBack: false });
    expect(out.content).toBe('The deposit is refundable.');
    expect(out.citations).toEqual([{ page: 7, clause: '9', quote: 'quote two' }]);
  });

  it('lists the source the prose leads with first', () => {
    const r = result({
      answers: [ans('P1', 3, '4', 'quote one'), ans('P2', 7, '9', 'quote two')],
      answer: [{ text: 'Both apply.', cites: ['P2', 'P1'] }],
    });
    const out = promptResultContent(r, { searchFellBack: false });
    expect(out.citations.map((c) => c.page)).toEqual([7, 3]);
  });

  it('keeps the verified quotes as sources when the write-up failed', () => {
    const r = result({ answers: [ans('P1', 3, '4', 'quote one')], error: 'Answer generation failed (http_500).' });
    const out = promptResultContent(r, { searchFellBack: false });
    expect(out.content).toBe('Answer generation failed (http_500).');
    expect(out.citations).toEqual([{ page: 3, clause: '4', quote: 'quote one' }]);
  });

  it('says so when nothing in the sections answers the question', () => {
    const out = promptResultContent(result({}), { searchFellBack: false });
    expect(out.content).toBe('I could not find an answer to this in the document.');
    expect(out.citations).toEqual([]);
  });

  it('puts the scan note in the stored answer text', () => {
    const r = result({ answers: [ans('P1', 1, '1', 'q')], answer: [{ text: 'Yes.', cites: ['P1'] }] });
    const out = promptResultContent(r, { searchFellBack: false, scanNote: 'Scanned 2 of 5 sections; 3 had no match for your terms (deposit).' });
    expect(out.content).toBe('Yes.\n\nScanned 2 of 5 sections; 3 had no match for your terms (deposit).');
  });

  it('notes a search that matched nothing, and sections that failed', () => {
    const r = result({
      answers: [ans('P1', 1, '1', 'q')],
      answer: [{ text: 'Yes.', cites: ['P1'] }],
      failedChunks: [{ chunkIndex: 2, pages: [5, 6], failureCode: 'timeout', message: null }],
    });
    const out = promptResultContent(r, { searchFellBack: true });
    expect(out.content).toContain('first sections of the document were read instead');
    expect(out.content).toContain('1 section could not be read');
  });
});

describe('chatSources', () => {
  const cite = (i: number) => ({ page: i, clause: String(i), quote: `q${i}` });

  it('caps a long source list and counts the rest', () => {
    const sources = chatSources(Array.from({ length: 6 }, (_, i) => cite(i + 1)));
    expect(sources.shown).toHaveLength(4);
    expect(sources.more).toBe(2);
  });

  it('shows a short source list in full', () => {
    const list = [cite(1), cite(2)];
    expect(chatSources(list)).toEqual({ shown: list, more: 0 });
  });
});

describe('citationLabel', () => {
  it('shows the clause and the page, or only the page when there is no clause', () => {
    expect(citationLabel({ clause: '4', page: 3, quote: 'q' })).toBe('Clause 4 · p. 3');
    expect(citationLabel({ clause: '', page: 3, quote: 'q' })).toBe('p. 3');
  });
});

describe('MODE_LABEL', () => {
  it('names each mode the way the message shows it', () => {
    expect(MODE_LABEL).toEqual({ saved: 'Saved report', retrieval: 'Retrieval', whole: 'Whole document' });
  });
});
