import { CallError, type CallRequest, type CallResult } from '../tasks/types';

interface StreamEnd {
  provider?: string | null;
  finish_reason?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
}

export function makeCallModel(opts: { functionsUrl: string; anonKey: string; accessToken: string }) {
  return async (req: CallRequest): Promise<CallResult> => {
    const started = Date.now();
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, req.timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(`${opts.functionsUrl}/ai-proxy`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            apikey: opts.anonKey,
            authorization: `Bearer ${opts.accessToken}`,
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
      } catch {
        throw new CallError(timedOut ? 'timeout' : 'network');
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        throw new CallError(body.code ?? `http_${res.status}`);
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
    const ev = JSON.parse(line) as { t: string; c?: string; code?: string } & StreamEnd;
    if (ev.t === 'd') state.text += ev.c ?? '';
    else if (ev.t === 'end') state.end = ev;
    else if (ev.t === 'error') throw new CallError(ev.code ?? 'stream_interrupted');
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
