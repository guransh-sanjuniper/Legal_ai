import { describe, it, expect } from 'vitest';
import { answersAboutQuestion, canonicalUnit, numericProblems } from './answerGuard';

describe('answersAboutQuestion (subject check)', () => {
  it('keeps a quote that states every subject term of the request', () => {
    const quote = 'The Licensee shall pay a security deposit of Rs. 50,000 on signing.';
    expect(answersAboutQuestion([{ quote }], 'What is the security deposit amount?')).toEqual([{ quote }]);
  });

  it('drops a quote that mentions only some of the subject terms', () => {
    const quote = 'Hardship compensation is payable at Rs. 70.00 per day of delay under Schedule B.';
    expect(answersAboutQuestion([{ quote }], 'What is the security deposit amount?')).toEqual([]);
  });

  it('keeps everything when the request has no subject terms', () => {
    const items = [{ quote: 'anything at all' }];
    expect(answersAboutQuestion(items, 'what is this?')).toEqual(items);
  });

  it('matches a term by its first six characters, so termination finds terminate', () => {
    const quote = 'Either party may terminate this agreement on thirty days written notice.';
    expect(answersAboutQuestion([{ quote }], 'What is the termination notice?')).toEqual([{ quote }]);
  });
});

describe('canonicalUnit', () => {
  it('gives one name per unit', () => {
    expect(canonicalUnit('Rs.')).toBe('rs');
    expect(canonicalUnit('INR')).toBe('rs');
    expect(canonicalUnit('₹')).toBe('rs');
    expect(canonicalUnit('rupees')).toBe('rs');
    expect(canonicalUnit('per cent')).toBe('%');
    expect(canonicalUnit('%')).toBe('%');
    expect(canonicalUnit('Days')).toBe('day');
  });
});

describe('numericProblems (numbers and units)', () => {
  const rateQuote = 'Hardship compensation is payable at Rs. 70.00 per day of delay under Schedule B.';

  it('passes a sentence that repeats the number with its unit from the quote', () => {
    expect(numericProblems('The hardship rate is Rs. 70.00 per day.', [rateQuote])).toEqual([]);
  });

  it('flags a bare number whose quote gives a unit', () => {
    const problems = numericProblems('The deposit is 70.00.', [rateQuote]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/unit \(rs\)|unit \(day\)/);
  });

  it('flags a number that is not in the cited quote', () => {
    expect(numericProblems('The deposit is Rs. 60,000.', ['The deposit is Rs. 50,000.'])).toEqual([
      '60,000 is not in the cited quote',
    ]);
  });

  it('matches amounts with thousands separators', () => {
    const quote = 'The Licensee shall pay a security deposit of Rs. 50,000 on signing.';
    expect(numericProblems('The security deposit is Rs. 50,000.', [quote])).toEqual([]);
  });

  it('does not treat a clause or section reference as an amount', () => {
    const quote = 'The Licensee shall pay a security deposit of Rs. 50,000 on signing.';
    expect(numericProblems('Clause 4 sets the deposit at Rs. 50,000.', [quote])).toEqual([]);
  });

  it('does not count "day" inside "today" as a unit', () => {
    expect(numericProblems('The fee is 5 today.', ['Fee 5 days'])).toHaveLength(1);
  });

  it('passes a number with no unit in the quote', () => {
    expect(numericProblems('The panel has 3 members.', ['The panel has 3 members.'])).toEqual([]);
  });
});
