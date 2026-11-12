import { CallError, type CallRequest, type CallResult } from '../tasks/types';

// Retry-After may be seconds ("60") or an HTTP date.
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return null;
}

interface StreamEnd {
  provider?: string | null;
  finish_reason?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
}

export function makeCallModel(opts: {
  functionsUrl: string;
  anonKey: string;
  accessToken: string;
  refreshToken?: (force?: boolean) => Promise<string | null>;
}) {
  return async (req: CallRequest): Promise<CallResult> => {
    const started = Date.now();
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, req.timeoutMs);
    try {
      let token = opts.accessToken;
      if (opts.refreshToken) {
        try {
          const fresh = await opts.refreshToken();
          if (fresh) token = fresh;
        } catch {
          // Use the supplied token if a refresh is not possible.
        }
      }

      const send = (accessToken: string): Promise<Response> =>
        fetch(`${opts.functionsUrl}/ai-proxy`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            apikey: opts.anonKey,
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            model: req.model,
            messages: [
              { role: 'system', content: req.prompt },
              { role: 'user', content: req.input },
            ],
            max_tokens: req.maxTokens,
            ...(req.reasoning ? { reasoning: req.reasoning } : {}),
          }),
          signal: ctrl.signal,
        });

      let res: Response;
      try {
        res = await send(token);
        if (res.status === 401 && opts.refreshToken) {
          const fresh = await opts.refreshToken(true).catch(() => null);
          if (fresh && fresh !== token) {
            await res.body?.cancel().catch(() => undefined);
            token = fresh;
            res = await send(token);
          }
        }
      } catch {
        throw new CallError(timedOut ? 'timeout' : 'network');
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string; retry_after?: number };
        const headerMs = parseRetryAfter(res.headers.get('retry-after'));
        const bodyMs =
          typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)
            ? Math.round(body.retry_after * 1000)
            : null;
        throw new CallError(body.code ?? `http_${res.status}`, body.message, headerMs ?? bodyMs ?? undefined);
      }
      return await readStream(res, () => timedOut, started);
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readStream(res: Response, timedOut: () => boolean, started: number): Promise<CallResult> {
  const state: { text: string; end: StreamEnd | null } = { text: '', end: null };
  const decoder = new TextDecoder();
  let buf = '';

  const handle = (line: string) => {
    if (!line.trim()) return;
    const ev = JSON.parse(line) as { t: string; c?: string; code?: string; message?: string } & StreamEnd;
    if (ev.t === 'd') state.text += ev.c ?? '';
    else if (ev.t === 'end') state.end = ev;
    else if (ev.t === 'error') throw new CallError(ev.code ?? 'stream_interrupted', ev.message);
  };

  try {
    const reader = res.body!.getReader();
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
    if (e instanceof CallError) throw e;
    throw new CallError(timedOut() ? 'timeout' : 'stream_interrupted');
  }

  const end = state.end;
  if (!end || !end.finish_reason) throw new CallError('stream_interrupted');
  return {
    text: state.text,
    finishReason: end.finish_reason,
    provider: end.provider ?? null,
    promptTokens: end.prompt_tokens ?? null,
    completionTokens: end.completion_tokens ?? null,
    durationMs: Date.now() - started,
  };
}
