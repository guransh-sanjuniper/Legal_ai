import type { PromptAnswer } from './types';

// How many supporting quotes (Deep Analysis) or source buttons (chat) are shown inline. A broad
// question can verify many quotes; the prose answer stays the main output and the rest are counted,
// never dropped from the stored report.
export const SUPPORTING_SOURCE_LIMIT = 4;

interface Cites {
  cites: string[];
}

// Where each answer first appears in the synthesis, so the quotes the prose leads with rank highest.
function citationOrder(sentences: Cites[]): Map<string, number> {
  const order = new Map<string, number>();
  for (const s of sentences) {
    for (const id of s.cites) if (!order.has(id)) order.set(id, order.size);
  }
  return order;
}

// Most representative first: direct answers before supporting quotes, then the order the prose
// cites them, then the order they arrived in.
export function rankPromptAnswers(answers: PromptAnswer[], sentences: Cites[] = []): PromptAnswer[] {
  const cited = citationOrder(sentences);
  const score = (a: PromptAnswer, i: number): [number, number, number] => [
    a.part === 'answer' ? 0 : 1,
    cited.get(a.itemId) ?? Number.MAX_SAFE_INTEGER,
    i,
  ];
  return answers
    .map((a, i) => ({ a, score: score(a, i) }))
    .sort((x, y) => x.score[0] - y.score[0] || x.score[1] - y.score[1] || x.score[2] - y.score[2])
    .map((x) => x.a);
}

export function limitSupporting<T>(items: T[], limit = SUPPORTING_SOURCE_LIMIT): { shown: T[]; more: number } {
  const shown = items.slice(0, Math.max(0, limit));
  return { shown, more: items.length - shown.length };
}

export function moreSourcesLabel(n: number): string {
  return `+${n} more source${n === 1 ? '' : 's'}`;
}
