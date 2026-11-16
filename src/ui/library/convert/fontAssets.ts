import devanagariUrl from './fonts/NotoSansDevanagari-Regular.ttf?url';
import latinUrl from './fonts/NotoSans-Regular.ttf?url';
import type { FontProvider, FontScript } from './types';

// Font files are emitted as separate assets by Vite: they are fetched only when a
// DOCX/text/Markdown conversion runs, and only once per worker.

const urls: Record<FontScript, string> = {
  latin: latinUrl,
  devanagari: devanagariUrl,
};

const cache = new Map<FontScript, Promise<Uint8Array>>();

async function fetchFont(script: FontScript): Promise<Uint8Array> {
  const response = await fetch(urls[script]);
  if (!response.ok) throw new Error(`Font request failed (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

export const loadBuiltinFont: FontProvider = (script) => {
  const cached = cache.get(script);
  if (cached) return cached;
  const request = fetchFont(script);
  cache.set(script, request);
  request.catch(() => cache.delete(script));
  return request;
};
