// Unicode-aware tokenizer: keeps letters, combining marks and numbers together, so
// Devanagari words (with matras) and Latin words stay intact. Marathi/Hindi text must not
// be split on combining marks.
const SEPARATOR = /[^\p{L}\p{M}\p{N}]+/u;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(SEPARATOR)
    .filter((t) => t.length > 0);
}

export const minisearchOptions = {
  fields: ['text'],
  storeFields: ['chunkId', 'windowIndex', 'pageStart', 'pageEnd'],
  tokenize,
  searchOptions: {
    tokenize,
    prefix: true,
    fuzzy: 0.1,
    boost: { text: 1 },
  },
};
