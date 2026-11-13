import { describe, it, expect } from 'vitest';
import { describeChatError } from './errors';
import { ChatError } from './stream';

describe('describeChatError', () => {
  it('explains a rate limit with the wait time', () => {
    expect(describeChatError(new ChatError('http_429', undefined, 30_000))).toBe(
      'Too many requests. Try again in about 30 seconds.',
    );
  });

  it('asks for sign-in again on an expired session', () => {
    expect(describeChatError(new ChatError('auth_required'))).toMatch(/sign in again/i);
  });

  it('shows the provider message for other failures', () => {
    expect(describeChatError(new ChatError('http_400', 'bad model'))).toBe('Request failed (http_400): bad model');
  });

  it('falls back for anything that is not a chat error', () => {
    expect(describeChatError(new TypeError('boom'))).toBe('Something went wrong. Try again.');
  });
});
