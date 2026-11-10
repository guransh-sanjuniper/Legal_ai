import { describe, it, expect } from 'vitest';
import { needsReembed, reembedReason } from './modelVersion';
import type { EmbeddingState } from './config';

const current = { model: 'Xenova/multilingual-e5-small', modelVersion: 'm@v1', dim: 384, prepFingerprint: 'prep-a' };
const state: EmbeddingState = {
  docId: 'd1',
  model: 'Xenova/multilingual-e5-small',
  modelVersion: 'm@v1',
  dim: 384,
  prepFingerprint: 'prep-a',
  windowsTotal: 10,
  completedAt: 1,
};

describe('embedding model-version check', () => {
  it('accepts a matching state', () => {
    expect(reembedReason(state, current)).toBeNull();
    expect(needsReembed(state, current)).toBe(false);
  });

  it('re-embeds when nothing is stored', () => {
    expect(reembedReason(undefined, current)).toBe('no_state');
  });

  it('re-embeds when the model id changed', () => {
    expect(reembedReason({ ...state, model: 'other/model' }, current)).toBe('model');
  });

  it('re-embeds when the pinned model version changed', () => {
    expect(reembedReason({ ...state, modelVersion: 'm@v0' }, current)).toBe('version');
  });

  it('re-embeds when the vector dimension changed', () => {
    expect(reembedReason({ ...state, dim: 768 }, current)).toBe('dim');
  });

  it('re-embeds when the preparation fingerprint changed (chunk config or pages)', () => {
    expect(reembedReason({ ...state, prepFingerprint: 'prep-b' }, current)).toBe('prep_fingerprint');
    expect(needsReembed({ ...state, prepFingerprint: 'prep-b' }, current)).toBe(true);
  });
});
