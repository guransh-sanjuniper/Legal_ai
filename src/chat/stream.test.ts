import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatError, readChatStream, streamChat } from './stream';

const encoder = new TextEncoder();

// Build a response whose body is split into arbitrary byte chunks, to exercise line buffering.
function ndjsonResponse(lines: unknown[], splitEvery = 7, status = 200): Response {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const bytes = encoder.encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += splitEvery) controller.enqueue(bytes.slice(i, i + splitEvery));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'application/x-ndjson' } });
}

const end = { t: 'end', provider: 'x', finish_reason: 'stop', prompt_tokens: 1, completion_tokens: 2 };

describe('readChatStream', () => {
  it('emits deltas as they arrive and returns the full text', async () => {
    const seen: string[] = [];
    const res = ndjsonResponse([{ t: 'd', c: 'Hel' }, { t: 'd', c: 'lo' }, end]);
    const out = await readChatStream(res, (c) => seen.push(c));
    expect(seen).toEqual(['Hel', 'lo']);
    expect(out).toEqual({ text: 'Hello', finishReason: 'stop' });
  });

  it('treats a stream with no end line as interrupted', async () => {
    const res = ndjsonResponse([{ t: 'd', c: 'partial' }]);
    await expect(readChatStream(res, () => {})).rejects.toMatchObject({ code: 'stream_interrupted' });
  });

  it('surfaces a proxy error line with its code', async () => {
    const res = ndjsonResponse([{ t: 'd', c: 'x' }, { t: 'error', code: 'timeout', message: 'slow' }]);
    await expect(readChatStream(res, () => {})).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('streamChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const base = {
    functionsUrl: 'https://example.test/functions/v1',
    anonKey: 'anon',
    model: 'm',
    maxTokens: 100,
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('posts the thread to ai-proxy with the user token', async () => {
    const fetchMock = vi.fn(async () => ndjsonResponse([{ t: 'd', c: 'ok' }, end]));
    vi.stubGlobal('fetch', fetchMock);
    const onDelta = vi.fn();
    const out = await streamChat({ ...base, getToken: async () => 'tok', onDelta });

    expect(out.text).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/functions/v1/ai-proxy');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'm', messages: base.messages, max_tokens: 100 });
  });

  it('refreshes the token once after a 401 and retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'auth_required' }), { status: 401 }))
      .mockResolvedValueOnce(ndjsonResponse([{ t: 'd', c: 'fine' }, end]));
    vi.stubGlobal('fetch', fetchMock);
    const getToken = vi.fn(async (force?: boolean) => (force ? 'fresh' : 'stale'));
    const out = await streamChat({ ...base, getToken, onDelta: () => {} });

    expect(out.text).toBe('fine');
    expect(getToken).toHaveBeenCalledWith(true);
    const second = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect((second.headers as Record<string, string>).authorization).toBe('Bearer fresh');
  });

  it('maps an HTTP error to its code and retry delay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 'http_429', message: 'slow down', retry_after: 30 }), { status: 429 }),
      ),
    );
    const err = await streamChat({ ...base, getToken: async () => 't', onDelta: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect(err).toMatchObject({ code: 'http_429', retryAfterMs: 30000, message: 'slow down' });
  });

  it('reports a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(streamChat({ ...base, getToken: async () => 't', onDelta: () => {} })).rejects.toMatchObject({
      code: 'network',
    });
  });
});
