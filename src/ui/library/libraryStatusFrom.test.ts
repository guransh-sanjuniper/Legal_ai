import { describe, expect, it } from 'vitest';
import type { DocumentRecord } from '../../runner/db';
import { libraryStatusFrom, stageLabel, statusLabel, statusTone } from './docStatus';
import type { PreparationState } from './preparationState';

const doc = (overrides: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id: 'doc',
  name: 'Doc',
  hash: 'hash',
  size: 1,
  createdAt: 1,
  status: 'ready',
  ocrLangs: 'eng',
  pageCount: 1,
  prepFingerprint: 'prep',
  chunkCount: 1,
  ...overrides,
});

const state = (overrides: Partial<PreparationState> = {}): PreparationState => ({
  docId: 'doc',
  stage: 'ingest',
  completedStages: [],
  docPrepFingerprint: null,
  progress: null,
  message: null,
  review: null,
  failed: null,
  preparedAt: null,
  preparedFingerprint: null,
  updatedAt: 1,
  ...overrides,
});

describe('library status derivation', () => {
  it('is Ready only when the durable preparation is complete', () => {
    expect(libraryStatusFrom({ doc: doc(), prepared: true, state: null, reviewPages: 0 })).toBe('ready');
  });

  it('shows a review document as Needs review', () => {
    expect(libraryStatusFrom({ doc: doc({ status: 'review' }), prepared: false, state: null, reviewPages: 2 })).toBe(
      'needs_review',
    );
  });

  it('shows a failed stage as Failed', () => {
    expect(
      libraryStatusFrom({
        doc: doc({ status: 'ready' }),
        prepared: false,
        state: state({ stage: 'failed', failed: { stage: 'definitions', message: 'boom' } }),
        reviewPages: 0,
      }),
    ).toBe('failed');
  });

  it('shows a ready document that is not prepared as Preparing', () => {
    expect(libraryStatusFrom({ doc: doc(), prepared: false, state: null, reviewPages: 0 })).toBe('preparing');
  });

  it('labels the stage and the failure', () => {
    expect(statusLabel('preparing', 0, 'embeddings')).toBe('Preparing · Embeddings');
    expect(statusLabel('failed', 0, 'definitions')).toBe('Failed');
    expect(stageLabel('definitions')).toBe('Definitions');
    expect(statusTone('failed')).toBe('danger');
  });
});
