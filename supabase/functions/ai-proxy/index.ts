import { createClient } from 'npm:@supabase/supabase-js@2';

const UPSTREAM = 'https://openrouter.ai/api/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = 100_000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { code: 'method_not_allowed' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) return json(401, { code: 'auth_required' });

  const limit = Number(Deno.env.get('RATE_LIMIT_PER_MIN') ?? '30');
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const { data: count, error: rlErr } = await admin.rpc('increment_rate_limit', {
    p_user: userData.user.id,
    p_window: windowStart,
  });
  if (rlErr) return json(500, { code: 'internal' });
  if ((count as number) > limit) return json(429, { code: 'http_429' });

  let body: { model?: unknown; messages?: unknown; max_tokens?: unknown; reasoning?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { code: 'bad_request' });
  }
  if (typeof body.model !== 'string' || !Array.isArray(body.messages)) return json(400, { code: 'bad_request' });
  const maxTokens = Number(body.max_tokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8000) return json(400, { code: 'bad_request' });

  const key = Deno.env.get('OPENROUTER_API_KEY') ?? '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'pipeline-harness' },
      body: JSON.stringify({
        model: body.model,
        messages: body.messages,
        max_tokens: maxTokens,
        ...(body.reasoning && typeof body.reasoning === 'object' ? { reasoning: body.reasoning } : {}),
        stream: true,
        usage: { include: true },
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as Error).name === 'AbortError';
    return json(aborted ? 504 : 502, { code: aborted ? 'timeout' : 'network' });
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    await upstream.body?.cancel();
    return json(upstream.status, { code: `http_${upstream.status}` });
  }

  // Normalised NDJSON: {t:"d",c} deltas, then one {t:"end",...} with provider, finish_reason, usage.
  // No "end" line means the stream was cut, and the client treats that as stream_interrupted.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      let provider: string | null = null;
      let finish: string | null = null;
      let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
      let buf = '';
      const dec = new TextDecoder();
      try {
        const reader = upstream.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]' || !data) continue;
            let j: any;
            try {
              j = JSON.parse(data);
            } catch {
              continue;
            }
            provider = provider ?? j.provider ?? null;
            const ch = j.choices?.[0];
            if (ch?.delta?.content) write({ t: 'd', c: ch.delta.content });
            if (ch?.finish_reason) finish = ch.finish_reason;
            if (j.usage) usage = j.usage;
          }
        }
        if (finish) {
          write({
            t: 'end',
            provider,
            finish_reason: finish,
            prompt_tokens: usage?.prompt_tokens ?? null,
            completion_tokens: usage?.completion_tokens ?? null,
          });
        }
      } catch (e) {
        const aborted = (e as Error).name === 'AbortError';
        write({ t: 'error', code: aborted ? 'timeout' : 'stream_interrupted' });
      } finally {
        clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // client already gone
        }
      }
    },
    cancel() {
      ctrl.abort();
    },
  });

  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
});
