// Model for general chat. Falls back the same way the analysis model does.
export const CHAT_MODEL =
  (import.meta.env.VITE_CHAT_MODEL as string) ||
  (import.meta.env.VITE_SEARCH_MODEL as string) ||
  (import.meta.env.VITE_MODEL as string) ||
  'deepseek/deepseek-v4.1-flash';

// Only the most recent messages are sent with each request.
export const CHAT_HISTORY_MESSAGES = 30;

export const CHAT_MAX_TOKENS = 4000;
