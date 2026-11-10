export type OcrLang = 'eng' | 'mar' | 'hin';

export type OcrReason = 'no_text' | 'too_few_words' | 'nonsense' | 'wrong_language';

export interface OcrCheck {
  ok: boolean;
  reason: OcrReason | null;
  letters: number;
  latinShare: number;
  devanagariShare: number;
  words: number;
  garbledRatio: number;
}

const ALLOWED = /[\p{L}\p{M}\p{N}\s.,;:()'"\-\/%&?!₹\[\]*+=@#]/u;

export function checkOcrOutput(text: string, langs: OcrLang[]): OcrCheck {
  const expectsIndic = langs.includes('mar') || langs.includes('hin');
  const chars = [...text];
  let letters = 0;
  let latin = 0;
  let deva = 0;
  let garbled = 0;
  let nonSpace = 0;
  for (const ch of chars) {
    if (/\s/.test(ch)) continue;
    nonSpace++;
    if (!ALLOWED.test(ch)) garbled++;
    if (/\p{L}/u.test(ch)) {
      letters++;
      if (/\p{Script=Latin}/u.test(ch)) latin++;
      if (/\p{Script=Devanagari}/u.test(ch)) deva++;
    }
  }
  const words = text.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length;
  const latinShare = letters ? latin / letters : 0;
  const devanagariShare = letters ? deva / letters : 0;
  const garbledRatio = nonSpace ? garbled / nonSpace : 0;

  const base = { letters, latinShare, devanagariShare, words, garbledRatio };
  if (letters === 0) return { ok: false, reason: 'no_text', ...base };
  if (words < 3) return { ok: false, reason: 'too_few_words', ...base };
  if (garbledRatio > 0.25) return { ok: false, reason: 'nonsense', ...base };
  if (expectsIndic && letters > 40 && devanagariShare < 0.05) {
    return { ok: false, reason: 'wrong_language', ...base };
  }
  if (!expectsIndic && devanagariShare > 0.2) {
    return { ok: false, reason: 'wrong_language', ...base };
  }
  if (!expectsIndic && letters > 20 && latinShare < 0.5) {
    return { ok: false, reason: 'wrong_language', ...base };
  }
  return { ok: true, reason: null, ...base };
}
