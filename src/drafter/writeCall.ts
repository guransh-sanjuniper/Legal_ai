import { ChatError, streamChat } from '../chat/stream';
import type { PlanStream } from './planCall';

// One plain-text writing call through the same direct ai-proxy path as chat, the plan and the
// outline. The engine owns retries; this makes one attempt.

export interface WriteCallDeps {
  functionsUrl: string;
  anonKey: string;
  getToken: (force?: boolean) => Promise<string | null>;
  model: string;
  maxTokens: number;
  // Test hook.
  stream?: PlanStream;
}

export type WriteCallResult =
  | { ok: true; text: string; durationMs: number }
  | {
      ok: false;
      code: string;
      message: string;
      durationMs: number;
      retryAfterMs?: number;
      raw: string;
    };

export async function writeSection(
  deps: WriteCallDeps,
  messages: { role: 'system' | 'user'; content: string }[],
): Promise<WriteCallResult> {
  const started = Date.now();
  let raw = '';
  try {
    const stream: PlanStream = deps.stream ?? streamChat;
    const result = await stream({
      functionsUrl: deps.functionsUrl,
      anonKey: deps.anonKey,
      getToken: deps.getToken,
      model: deps.model,
      maxTokens: deps.maxTokens,
      messages,
      onDelta: (text) => {
        raw += text;
      },
    });
    const durationMs = Date.now() - started;
    if (result.text) raw = result.text;

    if (result.finishReason === 'length') {
      return {
        ok: false,
        code: 'length',
        message: 'The section was cut off at the output limit. Write this section again.',
        durationMs,
        raw,
      };
    }
    const text = raw.trim();
    if (!text) {
      return {
        ok: false,
        code: 'empty_output',
        message: 'The model returned no text.',
        durationMs,
        raw,
      };
    }
    return { ok: true, text, durationMs };
  } catch (e) {
    const code = e instanceof ChatError ? e.code : 'network';
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      code,
      message,
      durationMs: Date.now() - started,
      retryAfterMs: e instanceof ChatError ? e.retryAfterMs : undefined,
      raw,
    };
  }
}
