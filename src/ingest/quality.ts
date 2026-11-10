export interface NativeQuality {
  chars: number;
  letters: number;
  replacementRatio: number;
  garbledRatio: number;
  brokenWordRatio: number;
  imageCount: number;
  verdict: 'native' | 'needs_ocr' | 'blank_candidate';
  reasons: string[];
}

const ALLOWED_SYMBOLS = /[\p{L}\p{M}\p{N}\s.,;:()'"\-\/%&?!₹%\[\]{}*+=@#]/u;
const SCRIPT_MIX = /(?=.*\p{Script=Latin})(?=.*\p{Script=Devanagari})/u;

export function assessNativeText(text: string, imageCount: number): NativeQuality {
  const trimmed = text.trim();
  const chars = trimmed.length;
  const nonSpace = [...trimmed.replace(/\s+/g, '')];
  const nonSpaceCount = nonSpace.length || 1;

  let letters = 0;
  let replacement = 0;
  let garbled = 0;
  for (const ch of nonSpace) {
    if (/\p{L}/u.test(ch)) letters++;
    if (ch === '\uFFFD') replacement++;
    if (ch === '\uFFFD' || !ALLOWED_SYMBOLS.test(ch)) garbled++;
  }

  const tokens = trimmed.split(/\s+/).filter((t) => t.length >= 4);
  const broken = tokens.filter((t) => SCRIPT_MIX.test(t) || /[a-z][A-Z]/.test(t)).length;
  const brokenWordRatio = tokens.length ? broken / tokens.length : 0;

  const replacementRatio = replacement / nonSpaceCount;
  const garbledRatio = garbled / nonSpaceCount;

  const reasons: string[] = [];
  let verdict: NativeQuality['verdict'] = 'native';

  if (chars < 15 && imageCount === 0) {
    verdict = 'blank_candidate';
    reasons.push('no_text_no_image');
  } else if (chars < 15) {
    verdict = 'needs_ocr';
    reasons.push('no_text_with_image');
  } else if (chars < 150 && imageCount > 0) {
    verdict = 'needs_ocr';
    reasons.push('thin_text_layer');
  }

  if (verdict === 'native') {
    if (replacementRatio > 0.01) {
      verdict = 'needs_ocr';
      reasons.push('replacement_chars');
    } else if (garbledRatio > 0.2) {
      verdict = 'needs_ocr';
      reasons.push('garbled_symbols');
    } else if (brokenWordRatio > 0.3) {
      verdict = 'needs_ocr';
      reasons.push('broken_words');
    }
  }

  return {
    chars,
    letters,
    replacementRatio,
    garbledRatio,
    brokenWordRatio,
    imageCount,
    verdict,
    reasons,
  };
}
