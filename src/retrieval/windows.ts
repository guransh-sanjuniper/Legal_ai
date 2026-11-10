import { sentenceSpans } from '../ingest/chunk';
import { WINDOW_MAX_TOKENS } from './config';

export interface Window {
  windowIndex: number;
  text: string;
  start: number;
  end: number;
  tokenEst: number;
}

// Splits a chunk into windows of at most maxTokens (chars/4), cutting only between
// sentences. A single sentence longer than the limit becomes its own window.
export function buildWindows(text: string, maxTokens = WINDOW_MAX_TOKENS): Window[] {
  const limitChars = maxTokens * 4;
  const spans = sentenceSpans(text);
  const windows: Window[] = [];
  let cur = '';
  let start = 0;
  let offset = 0;

  const flush = () => {
    if (!cur) return;
    windows.push({
      windowIndex: windows.length,
      text: cur,
      start,
      end: start + cur.length,
      tokenEst: Math.ceil(cur.length / 4),
    });
    cur = '';
  };

  for (const span of spans) {
    if (cur && cur.length + span.length > limitChars) {
      flush();
    }
    if (!cur) start = offset;
    cur += span;
    offset += span.length;
  }
  flush();
  if (windows.length === 0) {
    windows.push({ windowIndex: 0, text: '', start: 0, end: 0, tokenEst: 0 });
  }
  return windows;
}
