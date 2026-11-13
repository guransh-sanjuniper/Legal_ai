import type { ProviderMessage } from './thread';

// Chat calls ai-proxy directly so tokens can be shown as they arrive. The proxy speaks the same
// NDJSON as the runner: {t:"d",c} deltas, then one {t:"end",finish_reason}. No end line means the
// stream was cut.

export class ChatError extends Error {
  constructor(
    readonly code: string,
    message?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message ?? code);
    this.name = 'ChatError';
  }
}

export interface ChatStreamOpts {
  functionsUrl: string;
  anonKey: string;
  // Returns the user's access token. Called again with force=true after a 401.
  getToken: (force?: boolean) => Promise<string | null>;
  model: string;
  maxTokens: number;
  messages: ProviderMessage[];
  onDelta: (text: string) => void;
}

export interface ChatStreamResult {
  text: string;
  finishReason: string;
}

export async function streamChat(opts: ChatStreamOpts): Promise<ChatStreamResult> {
  let token = (await opts.getToken().catch(() => null)) ?? '';
  const send = (accessToken: string) =>
    fetch(`${opts.functionsUrl}/ai-proxy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: opts.anonKey,
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ model: opts.model, messages: opts.messages, max_tokens: opts.maxTokens }),
    });

  let res: Response;
  try {
    res = await send(token);
    if (res.status === 401) {
      const fresh = await opts.getToken(true).catch(() => null);
      if (fresh && fresh !== token) {
        await res.body?.cancel().catch(() => undefined);
        token = fresh;
        res = await send(token);
      }
    }
  } catch {
    throw new ChatError('network');
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string; retry_after?: number };
    const retryAfterMs =
      typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)
        ? Math.round(body.retry_after * 1000)
        : undefined;
    throw new ChatError(body.code ?? `http_${res.status}`, body.message ?? undefined, retryAfterMs);
  }

  return readChatStream(res, opts.onDelta);
}

export async function readChatStream(res: Response, onDelta: (text: string) => void): Promise<ChatStreamResult> {
  if (!res.body) throw new ChatError('stream_interrupted');
  const decoder = new TextDecoder();
  let text = '';
  let finishReason: string | null = null;
  let buf = '';

  const handle = (line: string) => {
    if (!line.trim()) return;
    const ev = JSON.parse(line) as { t: string; c?: string; code?: string; message?: string; finish_reason?: string };
    if (ev.t === 'd') {
      const chunk = ev.c ?? '';
      text += chunk;
      if (chunk) onDelta(chunk);
    } else if (ev.t === 'end') {
      finishReason = ev.finish_reason ?? null;
    } else if (ev.t === 'error') {
      throw new ChatError(ev.code ?? 'stream_interrupted', ev.message);
    }
  };

  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    buf += decoder.decode();
    handle(buf);
  } catch (e) {
    if (e instanceof ChatError) throw e;
    throw new ChatError('stream_interrupted');
  }

  if (!finishReason) throw new ChatError('stream_interrupted');
  return { text, finishReason };
}
