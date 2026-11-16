import { describe, expect, it } from 'vitest';
import { ChatError } from '../chat/stream';
import type { PlanStream } from './planCall';
import { writeSection } from './writeCall';

const messages = [
  { role: 'system' as const, content: 'system' },
  { role: 'user' as const, content: 'user' },
];

function deps(stream: PlanStream) {
  return {
    functionsUrl: 'http://proxy.test/functions/v1',
    anonKey: 'anon',
    getToken: async () => 'token',
    model: 'test-model',
    maxTokens: 100,
    stream,
  };
}

describe('writing call', () => {
  it('returns plain text', async () => {
    const stream: PlanStream = async (opts) => {
      opts.onDelta('The licensee shall pay rent.');
      return { text: 'The licensee shall pay rent.', finishReason: 'stop' };
    };
    const result = await writeSection(deps(stream), messages);
    expect(result).toMatchObject({ ok: true, text: 'The licensee shall pay rent.' });
  });

  it('never accepts a reply cut at the output limit', async () => {
    const stream: PlanStream = async () => ({ text: 'partial', finishReason: 'length' });
    const result = await writeSection(deps(stream), messages);
    expect(result).toMatchObject({ ok: false, code: 'length' });
  });

  it('treats empty output as a failure', async () => {
    const stream: PlanStream = async () => ({ text: '   ', finishReason: 'stop' });
    const result = await writeSection(deps(stream), messages);
    expect(result).toMatchObject({ ok: false, code: 'empty_output' });
  });

  it('passes a proxy error through', async () => {
    const stream: PlanStream = async () => {
      throw new ChatError('http_429', 'rate limited by provider', 2000);
    };
    const result = await writeSection(deps(stream), messages);
    expect(result).toMatchObject({ ok: false, code: 'http_429', message: 'rate limited by provider' });
    if (!result.ok) expect(result.retryAfterMs).toBe(2000);
  });

  it('reports a network error without throwing', async () => {
    const stream: PlanStream = async () => {
      throw new Error('offline');
    };
    const result = await writeSection(deps(stream), messages);
    expect(result).toMatchObject({ ok: false, code: 'network', message: 'offline' });
  });
});
