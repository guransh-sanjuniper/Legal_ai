import { describe, it, expect } from 'vitest';
import { assessNativeText, renderProblem } from './quality';
import { checkOcrOutput } from './ocrCheck';

const PROSE =
  'The Developer shall hand over possession of the unit on or before the agreed date, subject to force majeure and payment of all dues by the Purchaser.';

describe('native page quality', () => {
  it('accepts normal text with no images', () => {
    expect(assessNativeText(PROSE, 0).verdict).toBe('native');
  });

  it('does not reject long clean text just because it has images (logo, stamp)', () => {
    expect(assessNativeText(PROSE.repeat(2), 2).verdict).toBe('native');
  });

  it('flags an image-only page (no text layer) as needing OCR', () => {
    const q = assessNativeText('', 1);
    expect(q.verdict).toBe('needs_ocr');
    expect(q.reasons).toContain('no_text_with_image');
  });

  it('marks an empty page with no image as a blank candidate', () => {
    expect(assessNativeText('   ', 0).verdict).toBe('blank_candidate');
  });

  it('flags a thin text layer on a page with an image', () => {
    const q = assessNativeText('Short stamp text here only.', 1);
    expect(q.verdict).toBe('needs_ocr');
    expect(q.reasons).toContain('thin_text_layer');
    expect(assessNativeText('Short stamp text here only.', 0).verdict).toBe('native');
  });

  it('flags replacement characters as garbled', () => {
    const garbled = PROSE + ' ' + '\uFFFD'.repeat(40);
    const q = assessNativeText(garbled, 0);
    expect(q.verdict).toBe('needs_ocr');
    expect(q.reasons).toContain('replacement_chars');
  });

  it('flags symbol-heavy text as garbled even with no replacement characters', () => {
    const symbols = '§¤¶§¤¶§¤¶§¤¶§¤¶§¤¶§¤¶§¤¶§¤¶§¤¶§¤¶§¤¶§¤¶§¤¶§¤¶';
    const q = assessNativeText('ab cd ef gh ij ' + symbols, 0);
    expect(q.verdict).toBe('needs_ocr');
    expect(q.reasons).toContain('garbled_symbols');
  });

  it('flags broken words where Latin and Devanagari are glued together', () => {
    const broken = Array.from({ length: 12 }, () => 'Possessionकरार').join(' ') + ' ' + PROSE;
    const q = assessNativeText(broken, 0);
    expect(q.verdict).toBe('needs_ocr');
    expect(q.reasons).toContain('broken_words');
  });
});

describe('OCR output check', () => {
  const ENGLISH =
    'The Developer shall hand over possession of the unit to the Purchaser on or before the agreed date and this clause is binding on all parties.';
  const MARATHI = 'भाडेकरू यांनी हा करार स्वीकारला असून सर्व अटी व शर्ती मान्य केल्या आहेत आणि त्याची अंमलबजावणी करण्यात येईल.';

  it('accepts English output when English is selected', () => {
    expect(checkOcrOutput(ENGLISH, ['eng']).ok).toBe(true);
  });

  it('accepts Marathi output when Marathi is selected', () => {
    expect(checkOcrOutput(MARATHI, ['eng', 'mar']).ok).toBe(true);
  });

  it('flags English output when Marathi is selected (wrong language)', () => {
    const r = checkOcrOutput(ENGLISH.repeat(2), ['eng', 'mar']);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong_language');
  });

  it('flags Devanagari output when only English is selected (wrong language)', () => {
    const r = checkOcrOutput(MARATHI.repeat(2), ['eng']);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong_language');
  });

  it('rejects nonsense output even though it has some words', () => {
    const r = checkOcrOutput('ab cd ef gh ij ' + '§'.repeat(40), ['eng']);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('nonsense');
  });

  it('rejects output with too few real words', () => {
    expect(checkOcrOutput('Hi there', ['eng']).reason).toBe('too_few_words');
    expect(checkOcrOutput('1 2 3 4', ['eng']).reason).toBe('no_text');
  });
});


describe('render problem classification', () => {
  it('flags image masks that rendered almost blank', () => {
    expect(renderProblem(0.0044, 37)).toBe('render_decode_failed');
    expect(renderProblem(0.0005, 37)).toBe('render_decode_failed');
  });

  it('keeps a genuinely blank page as blank_candidate', () => {
    expect(renderProblem(0.0002, 1)).toBe('blank_candidate');
    expect(renderProblem(0, 0)).toBe('blank_candidate');
  });

  it('accepts a page with real ink', () => {
    expect(renderProblem(0.053, 37)).toBeNull();
  });
});
