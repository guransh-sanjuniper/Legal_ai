import { describe, it, expect } from 'vitest';
import { tokenize } from './tokenize';

describe('Unicode tokenizer', () => {
  it('keeps Marathi words intact, including matras and virama', () => {
    expect(tokenize('करार आणि पुनर्विकास')).toEqual(['करार', 'आणि', 'पुनर्विकास']);
    expect(tokenize('सदस्यांना ताबा तीस दिवसांत द्यावा')).toEqual(['सदस्यांना', 'ताबा', 'तीस', 'दिवसांत', 'द्यावा']);
  });

  it('keeps Hindi words intact', () => {
    expect(tokenize('यह अनुबंध पंजीकरण की तारीख से लागू होगा')).toEqual([
      'यह', 'अनुबंध', 'पंजीकरण', 'की', 'तारीख', 'से', 'लागू', 'होगा',
    ]);
  });

  it('does not split on combining marks alone', () => {
    // "क्ष" and "ज्ञ" are conjuncts written with virama + consonant.
    expect(tokenize('क्षेत्र ज्ञान')).toEqual(['क्षेत्र', 'ज्ञान']);
  });

  it('handles Latin, numbers and mixed punctuation', () => {
    expect(tokenize('The Developer, Unit-12 / 2027. Rs.52.50')).toEqual([
      'the', 'developer', 'unit', '12', '2027', 'rs', '52', '50',
    ]);
  });

  it('keeps Devanagari digits and Latin letters together as separate tokens', () => {
    expect(tokenize('३.१ ताबा (clause 31)')).toEqual(['३', '१', 'ताबा', 'clause', '31']);
  });

  it('drops empty tokens', () => {
    expect(tokenize('   ,, --  ')).toEqual([]);
  });
});
