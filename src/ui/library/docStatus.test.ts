import { describe, expect, it } from 'vitest';
import { libraryStatus, statusLabel, statusTone } from './docStatus';

describe('library status derivation', () => {
  it('maps ingestion status to a library status', () => {
    expect(libraryStatus('ready')).toBe('ready');
    expect(libraryStatus('review')).toBe('needs_review');
    expect(libraryStatus('processing')).toBe('preparing');
    expect(libraryStatus('new')).toBe('preparing');
  });

  it('labels review counts', () => {
    expect(statusLabel('ready')).toBe('Ready');
    expect(statusLabel('preparing')).toBe('Preparing');
    expect(statusLabel('needs_review', 0)).toBe('Needs review');
    expect(statusLabel('needs_review', 1)).toBe('Needs review (1 page)');
    expect(statusLabel('needs_review', 7)).toBe('Needs review (7 pages)');
  });

  it('assigns chip tones', () => {
    expect(statusTone('ready')).toBe('ok');
    expect(statusTone('needs_review')).toBe('warn');
    expect(statusTone('preparing')).toBe('neutral');
  });
});
