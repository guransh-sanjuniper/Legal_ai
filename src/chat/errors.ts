import { ChatError } from './stream';

// What the user sees when a reply fails. Codes come from ai-proxy and the stream reader.
export function describeChatError(err: unknown): string {
  if (!(err instanceof ChatError)) return 'Something went wrong. Try again.';
  switch (err.code) {
    case 'network':
      return 'Could not reach the assistant. Check your connection and try again.';
    case 'timeout':
      return 'The reply took too long. Try again.';
    case 'stream_interrupted':
      return 'The reply was interrupted. Try again.';
    case 'empty_output':
      return 'The assistant returned no text. Try again.';
    case 'auth_required':
    case 'http_401':
      return 'Your sign-in has expired. Sign in again to continue.';
    case 'http_429': {
      const wait = err.retryAfterMs ? Math.max(1, Math.ceil(err.retryAfterMs / 1000)) : null;
      return wait ? `Too many requests. Try again in about ${wait} seconds.` : 'Too many requests. Try again shortly.';
    }
    default:
      return err.message && err.message !== err.code
        ? `Request failed (${err.code}): ${err.message}`
        : `Request failed (${err.code}). Try again.`;
  }
}
