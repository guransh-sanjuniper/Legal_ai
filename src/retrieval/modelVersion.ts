import type { EmbeddingState } from './config';

export interface CurrentEmbeddingConfig {
  model: string;
  modelVersion: string;
  dim: number;
  prepFingerprint: string;
}

export type ReembedReason = 'no_state' | 'model' | 'version' | 'dim' | 'prep_fingerprint' | null;

export function reembedReason(
  state: EmbeddingState | undefined | null,
  current: CurrentEmbeddingConfig,
): ReembedReason {
  if (!state) return 'no_state';
  if (state.model !== current.model) return 'model';
  if (state.modelVersion !== current.modelVersion) return 'version';
  if (state.dim !== current.dim) return 'dim';
  if (state.prepFingerprint !== current.prepFingerprint) return 'prep_fingerprint';
  return null;
}

export function needsReembed(state: EmbeddingState | undefined | null, current: CurrentEmbeddingConfig): boolean {
  return reembedReason(state, current) !== null;
}
