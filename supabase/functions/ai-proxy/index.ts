import { createClient } from 'npm:@supabase/supabase-js@2';

const UPSTREAM = 'https://openrouter.ai/api/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = 100_000;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// Transport only: the hosted gateway does not add CORS headers to browser preflights.
// Set ALLOWED_ORIGIN to a comma-separated list to lock the app down; unset means any origin.
const corsHeaders = (req: Request): Record<string, string> => {
  const origin = req.headers.get('origin');
  const configured = (Deno.env.get('ALLOWED_ORIGIN') ?? '').trim();
  const allowed = configured
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const base = {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
    'access-control-max-age': '86400',
  };
  if (!configured) return { ...base, 'access-control-allow-origin': '*' };
  if (origin && allowed.includes(origin)) return { ...base, 'access-control-allow-origin': origin, vary: 'Origin' };
  return {};
};

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { code: 'method_not_allowed' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) return json(401, { code: 'auth_required' });

  const configured = Number(Deno.env.get('RATE_LIMIT_PER_MIN') ?? '40');
  const limit = Number.isInteger(configured) && configured > 0 ? configured : 40;
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const retryAfter = Math.max(1, 60 - (Math.floor(Date.now() / 1000) % 60));
  const { data: admitted, error: rlErr } = await admin.rpc('admit_rate_limit', {
    p_user: userData.user.id,
    p_window: windowStart,
    p_limit: limit,
  });
  if (rlErr) return json(500, { code: 'internal' });
  if (admitted === null || admitted === undefined) {
    return json(
      429,
      { code: 'http_429', message: 'per-user rate limit', retry_after: retryAfter, limit, used: limit },
      { 'Retry-After': String(retryAfter), 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining': '0' },
    );
  }

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
    const raw = await upstream.text().catch(() => '');
    let message = raw.slice(0, 1000);
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
      const m = parsed.error?.message ?? parsed.message;
      if (typeof m === 'string') message = m.slice(0, 1000);
    } catch {
      // Keep the raw body when it is not JSON.
    }
    const upstreamRetry = upstream.headers.get('retry-after');
    const retrySeconds = upstreamRetry && /^\d+$/.test(upstreamRetry) ? Number(upstreamRetry) : 60;
    return json(
      upstream.status,
      { code: `http_${upstream.status}`, message: message || null, retry_after: retrySeconds },
      { 'Retry-After': String(retrySeconds) },
    );
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
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') {
    if (Object.keys(cors).length === 0) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors });
  }
  const res = await handle(req);
  for (const [key, value] of Object.entries(cors)) res.headers.set(key, value);
  return res;
});
