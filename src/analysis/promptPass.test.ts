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

  it('puts direct answers before supporting quotes, keeping document order within each group', () => {
    const merged = mergeAnswers([
      { ...located('Support one.', 2, 'quote two text here', 'C2'), item: { text: 'Support one.', page: 2, quote: 'quote two text here', clause: 'C2', verified: true, part: 'support' } as never },
      { ...located('Yes.', 5, 'the notice is sixty days', 'C5'), item: { text: 'Yes.', page: 5, quote: 'the notice is sixty days', clause: 'C5', verified: true, part: 'answer' } as never },
      { ...located('Yes again.', 1, 'the notice is sixty days', 'C1'), item: { text: 'Yes again.', page: 1, quote: 'the notice is sixty days', clause: 'C1', verified: true, part: 'answer' } as never },
    ]);
    expect(merged.map((a) => [a.part, a.page])).toEqual([
      ['answer', 5],
      ['answer', 1],
      ['support', 2],
    ]);
    expect(merged.map((a) => a.itemId)).toEqual(['P1', 'P2', 'P3']);
  });

  it('frames the prompt with the reviewing side but never limits it', () => {
    expect(promptPrompt('q', 'neutral')).not.toMatch(/REVIEWING FOR/);
    const licensor = promptPrompt('q', 'licensor');
    expect(licensor).toMatch(/REVIEWING FOR: the licensor/);
    expect(licensor).toMatch(/report every issue/);
  });

  it('asks for no fixed length or format in the custom answer', () => {
    const p = promptPrompt('Which clauses name a notice period?');
    expect(p).toMatch(/form and length of the answer are set by the request itself/);
    expect(p).not.toMatch(/at most|exactly \d+ (sentences|items)/);
  });
});
