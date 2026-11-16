import { describe, it, expect } from 'vitest';
import type { PromptAnswer } from './types';
import { SUPPORTING_SOURCE_LIMIT, limitSupporting, moreSourcesLabel, rankPromptAnswers } from './supportingSources';

const answer = (id: string, over: Partial<PromptAnswer> = {}): PromptAnswer => ({
  itemId: id,
  text: `text ${id}`,
  clause: '1',
  page: 1,
  quote: `quote ${id}`,
  verified: true,
  ...over,
});

describe('rankPromptAnswers', () => {
  it('puts direct answers first, then the order the prose cites them, then input order', () => {
    const input = [
      answer('support-first', { part: 'support' }),
      answer('answer-later', { part: 'answer' }),
      answer('answer-cited', { part: 'answer' }),
      answer('support-uncited', { part: 'support' }),
    ];
    const ranked = rankPromptAnswers(input, [{ cites: ['support-first', 'answer-cited'] }]);
    expect(ranked.map((a) => a.itemId)).toEqual(['answer-cited', 'answer-later', 'support-first', 'support-uncited']);
  });
});

describe('limitSupporting', () => {
  it('caps a long list and reports how many were left out', () => {
    const items = [1, 2, 3, 4, 5, 6];
    expect(limitSupporting(items)).toEqual({ shown: [1, 2, 3, 4], more: 2 });
    expect(SUPPORTING_SOURCE_LIMIT).toBe(4);
  });

  it('shows a short list in full with no more count', () => {
    expect(limitSupporting([1, 2])).toEqual({ shown: [1, 2], more: 0 });
  });

  it('labels the hidden count and pluralises it', () => {
    expect(moreSourcesLabel(1)).toBe('+1 more source');
    expect(moreSourcesLabel(3)).toBe('+3 more sources');
  });
});
