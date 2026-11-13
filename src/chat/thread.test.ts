import { describe, it, expect } from 'vitest';
import {
  CHAT_SYSTEM_PROMPT,
  TITLE_MAX,
  buildRequestMessages,
  generalHistory,
  titleFrom,
  type ThreadMessage,
} from './thread';

describe('generalHistory', () => {
  it('drops messages that came from a document turn', () => {
    const msgs = [
      { role: 'user' as const, content: 'general q', documentId: null },
      { role: 'assistant' as const, content: 'general a', documentId: null },
      { role: 'user' as const, content: 'doc q', documentId: 'doc-1' },
      { role: 'assistant' as const, content: 'doc a', documentId: 'doc-1' },
    ];
    expect(generalHistory(msgs).map((m) => m.content)).toEqual(['general q', 'general a']);
  });

  it('keeps a general thread whole', () => {
    const msgs = [{ role: 'user' as const, content: 'hi', documentId: null }];
    expect(generalHistory(msgs)).toEqual(msgs);
  });
});

describe('titleFrom', () => {
  it('collapses whitespace and keeps short text whole', () => {
    expect(titleFrom('  What is\n\n  a deposit?  ')).toBe('What is a deposit?');
  });

  it('truncates long text with an ellipsis within the limit', () => {
    const title = titleFrom('x'.repeat(200));
    expect(title.length).toBe(TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back for empty input', () => {
    expect(titleFrom('   ')).toBe('New chat');
  });
});

describe('buildRequestMessages', () => {
  const turns = (n: number): ThreadMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }) as ThreadMessage);

  it('starts with the system prompt and keeps a short thread whole', () => {
    const out = buildRequestMessages(turns(3));
    expect(out[0]).toEqual({ role: 'system', content: CHAT_SYSTEM_PROMPT });
    expect(out.slice(1).map((m) => m.content)).toEqual(['m0', 'm1', 'm2']);
  });

  it('sends at most the last 30 messages', () => {
    // The last 30 of 35 begin with m5 (an assistant reply), which is dropped so the window starts
    // with a user message: 29 messages remain.
    const out = buildRequestMessages(turns(35), 30);
    expect(out.length).toBe(1 + 29);
    expect(out[1].content).toBe('m6');
  });

  it('never starts the window with an assistant reply', () => {
    // 31 messages: the window of the last 30 would start on an assistant message (index 1).
    const out = buildRequestMessages(turns(31), 30);
    expect(out[1].role).toBe('user');
    expect(out[1].content).toBe('m2');
  });
});
