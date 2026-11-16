import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearConversionMeta,
  conversionMetaKey,
  conversionNote,
  readConversionMeta,
  writeConversionMeta,
  type ConversionMeta,
} from './conversionMeta';

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

const meta: ConversionMeta = {
  kind: 'docx',
  label: 'Word',
  originalName: 'Lease.docx',
  originalSize: 12_345,
  warnings: ['Unsupported characters were replaced.'],
  convertedAt: 1_700_000_000_000,
};

describe('conversion metadata', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage());
  });

  it('round-trips the converted-from note in localStorage', () => {
    writeConversionMeta('doc-1', meta);
    expect(localStorage.getItem(conversionMetaKey('doc-1'))).not.toBeNull();
    expect(readConversionMeta('doc-1')).toEqual(meta);
    expect(conversionNote(meta)).toBe('Converted from Word');
  });

  it('returns null for a missing or malformed record', () => {
    expect(readConversionMeta('missing')).toBeNull();
    localStorage.setItem(conversionMetaKey('bad'), '{not json');
    expect(readConversionMeta('bad')).toBeNull();
    localStorage.setItem(conversionMetaKey('wrong'), JSON.stringify({ kind: 'pdf' }));
    expect(readConversionMeta('wrong')).toBeNull();
  });

  it('clears the record when a document is removed', () => {
    writeConversionMeta('doc-1', meta);
    clearConversionMeta('doc-1');
    expect(readConversionMeta('doc-1')).toBeNull();
  });
});
