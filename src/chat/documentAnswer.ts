import type { Citation } from '../analysis/reportModel';
import type { PromptAnswer, PromptResult } from '../analysis/types';
import type { ChatMode } from './store';
import { uniqueCitations, type SavedRow } from './route';

// Pure text and citation builders for a document answer. No I/O, no model call.

export const SOURCE_LIMIT = 8;

export const MODE_LABEL: Record<ChatMode, string> = {
  saved: 'Saved report',
  retrieval: 'Retrieval',
  whole: 'Whole document',
};

// The source button text: the clause (when there is one) and the page.
export function citationLabel(c: Citation): string {
  return c.clause ? `Clause ${c.clause} · p. ${c.page}` : `p. ${c.page}`;
}

export function savedContent(rows: SavedRow[], total: number): string {
  const head =
    total > rows.length
      ? `From the saved analysis report (no model call). Showing ${rows.length} of ${total} matching rows.`
      : 'From the saved analysis report (no model call).';
  return `${head}\n\n${rows.map((r) => `- **${r.label}**: ${r.text}`).join('\n')}`;
}

export function savedCitations(rows: SavedRow[]): Citation[] {
  return uniqueCitations(rows.map((r) => r.citation));
}

const citeOf = (a: PromptAnswer): Citation => ({ page: a.page, clause: a.clause, quote: a.quote });

export interface PromptTextOptions {
  // True when search failed or matched nothing, so the prompt pass read the first sections instead.
  searchFellBack: boolean;
}

// The written answer from a prompt pass (retrieval or whole). Sentences cite verified answer ids;
// only those answers are shown as sources. When the write-up failed, the verified quotes are the
// sources and the stored error says so.
export function promptResultContent(result: PromptResult, opts: PromptTextOptions): { content: string; citations: Citation[] } {
  const notes: string[] = [];
  if (opts.searchFellBack) {
    notes.push('Search did not find matching sections for this question, so the first sections of the document were read instead.');
  }
  if (result.failedChunks.length > 0) {
    const n = result.failedChunks.length;
    notes.push(`${n} section${n === 1 ? '' : 's'} could not be read, so the answer may be incomplete.`);
  }
  const answers = result.answers;
  const sentences = result.answer ?? [];

  if (sentences.length > 0) {
    const cited = new Set(sentences.flatMap((s) => s.cites));
    const text = sentences.map((s) => s.text).join(' ');
    return {
      content: [text, ...notes].join('\n\n'),
      citations: uniqueCitations(answers.filter((a) => cited.has(a.itemId)).map(citeOf)),
    };
  }
  if (result.error) {
    return {
      content: [result.error, ...notes].join('\n\n'),
      citations: uniqueCitations(answers.slice(0, SOURCE_LIMIT).map(citeOf)),
    };
  }
  if (answers.length === 0) {
    return { content: ['I could not find an answer to this in the document.', ...notes].join('\n\n'), citations: [] };
  }
  return {
    content: ['The verified quotes below answer the question.', ...notes].join('\n\n'),
    citations: uniqueCitations(answers.slice(0, SOURCE_LIMIT).map(citeOf)),
  };
}
