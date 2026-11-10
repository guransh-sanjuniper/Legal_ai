// Pinned embedding model. Change EMBED_MODEL_VERSION whenever the model, dtype or prefix
// scheme changes: stored vectors without a matching version are re-embedded.
export const EMBED_MODEL_ID = 'Xenova/multilingual-e5-small';
export const EMBED_MODEL_DTYPE = 'q8';
export const EMBED_MODEL_VERSION = `${EMBED_MODEL_ID}@${EMBED_MODEL_DTYPE}-v1`;
export const EMBED_DIM = 384;

export const PASSAGE_PREFIX = 'passage: ';
export const QUERY_PREFIX = 'query: ';

// Windows are at most this many estimated tokens (characters / 4); each window points at
// its parent chunk.
export const WINDOW_MAX_TOKENS = 400;

// Reciprocal rank fusion constant.
export const RRF_K = 60;

// Results scoring below this fraction of the best fused score are dropped, so a weak
// match never gets forced into the top-k.
export const MIN_RELATIVE_SCORE = 0.35;

export const LAW_STANDIN_VERSION = 'law-standin-v1';

export interface EmbeddingState {
  docId: string;
  model: string;
  modelVersion: string;
  dim: number;
  prepFingerprint: string;
  windowsTotal: number;
  completedAt: number | null;
}
