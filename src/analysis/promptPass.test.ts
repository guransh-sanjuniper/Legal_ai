import { describe, it, expect } from 'vitest';
import { isValidAnswerItem, mergeAnswers, promptPrompt, type RawAnswer } from './promptPass';
import type { Located } from './verify';

const located = (text: string, page: number, quote: string, clause: string): Located<RawAnswer> => ({
  corrected: false,
  item: { text, page, quote, clause, verified: true } as RawAnswer & Located<RawAnswer>['item'],
});

describe('custom prompt pass', () => {
  it('wraps the user request in the answer header and footer', () => {
    const p = promptPrompt('List the notice periods');
    expect(p).toMatch(/USER REQUEST: List the notice periods/);
    expect(p).toMatch(/verbatim quote/);
  });

  it('validates answer items by shape', () => {
    expect(isValidAnswerItem({ text: 'a', quote: 'b', page: 2 })).toBe(true);
    expect(isValidAnswerItem({ text: 'a', quote: 'b' })).toBe(false);
    expect(isValidAnswerItem(null)).toBe(false);
  });

  it('merges answers from overlapping chunks once, with sequential IDs', () => {
    const merged = mergeAnswers([
      located('Notice is 30 days.', 4, 'Either party may give 30 days notice.', 'C3'),
      located('Notice is 30 days again.', 4, 'either party may give  30 days notice.', 'C3'),
      located('Deposit is refundable.', 6, 'The deposit is refundable on exit.', 'C5'),
      located('   ', 7, 'Some quote here.', 'C6'),
    ]);
    expect(merged.map((a) => a.itemId)).toEqual(['P1', 'P2']);
    expect(merged[1]).toMatchObject({ clause: 'C5', page: 6, verified: true });
  });
});
