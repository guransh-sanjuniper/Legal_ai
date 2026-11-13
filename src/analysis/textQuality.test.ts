import { describe, it, expect } from 'vitest';
import { buildAnchorIndex } from './anchors';
import {
  blankAffectsTerm,
  extractDraftingIssues,
  findBlanks,
  findComments,
  signatureBlockLines,
} from './textQuality';

const pages = (texts: string[]) => new Map(texts.map((t, i) => [i + 1, t]));

describe('drafting issues', () => {
  it('finds blanks and reviewer comments by code', () => {
    expect(findBlanks('The fee is Rs. ____ per month.')).toEqual(['____']);
    expect(findBlanks('Notice of [ ] days shall apply.')).toEqual(['[ ]']);
    expect(findBlanks('A period of ___ days applies.')).toEqual(['___ days']);
    expect(findComments('Commented [AB1]: confirm this')).toEqual(['Commented [AB1]']);
    expect(findComments('Payment [TBC] on completion')).toEqual(['[TBC]']);
    expect(findBlanks('Nothing here.')).toEqual([]);
  });

  it('treats a blank touching money, time or a party as a term risk', () => {
    expect(blankAffectsTerm('The deposit is Rs. ____.')).toBe(true);
    expect(blankAffectsTerm('Notice of ___ days.')).toBe(true);
    expect(blankAffectsTerm('The ____ shall sign.')).toBe(true);
    expect(blankAffectsTerm('Signed at ____ place of execution decoration.')).toBe(false);
  });

  it('counts blanks in operative text and groups them by clause and page', () => {
    const text = ['1. Payment', 'The Buyer shall pay Rs. ____ on completion.', '2. Notice', 'Either party may give ___ days notice.'].join('\n');
    const p = pages([text]);
    const issues = extractDraftingIssues(p, buildAnchorIndex(p));
    expect(issues.blankCount).toBe(2);
    expect(issues.groups.map((g) => g.clause)).toEqual(['1', '2']);
    expect(issues.groups.every((g) => g.page === 1)).toBe(true);
  });

  it('excludes signature and witness blocks from the count', () => {
    const text = [
      '1. Payment',
      'The Buyer shall pay Rs. ____ on completion.',
      'IN WITNESS WHEREOF the parties have signed:',
      'Name: ____',
      'Witness: ____',
    ].join('\n');
    const p = pages([text]);
    expect(signatureBlockLines(p).has('Name: ____')).toBe(true);
    const issues = extractDraftingIssues(p, buildAnchorIndex(p));
    expect(issues.blankCount).toBe(1);
  });

  it('leaves the section empty and adds nothing when a document has no blanks or comments', () => {
    const p = pages(['1. Payment', 'The Buyer shall pay Rs. 48,000 on completion.']);
    const issues = extractDraftingIssues(p, buildAnchorIndex(p));
    expect(issues).toEqual({ blankCount: 0, commentCount: 0, groups: [] });
  });
});
