import { CHAT_HISTORY_MESSAGES } from './config';

export type ChatRole = 'user' | 'assistant';

export interface ThreadMessage {
  role: ChatRole;
  content: string;
}

export interface ProviderMessage {
  role: 'system' | ChatRole;
  content: string;
}

export const TITLE_MAX = 60;

export const CHAT_SYSTEM_PROMPT =
  'You are a legal research assistant in a document workspace. No document is attached to this chat. ' +
  'Answer the question asked, say when you are not sure, and do not invent statutes, cases or clause numbers. ' +
  'Your answers are AI-assisted and require lawyer review.';

// A session is titled from its first message: whitespace collapsed and truncated.
export function titleFrom(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return 'New chat';
  if (collapsed.length <= TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

// General requests carry only messages that have no document context. Document turns are never
// sent back to the model as history, so a General answer is not grounded in a document.
export function generalHistory<T extends { documentId: string | null }>(messages: T[]): T[] {
  return messages.filter((m) => m.documentId === null);
}

// The request thread: the system prompt, then the last CHAT_HISTORY_MESSAGES messages. The
// window always starts with a user message so the model never sees a reply without its question.
export function buildRequestMessages(
  history: ThreadMessage[],
  limit: number = CHAT_HISTORY_MESSAGES,
): ProviderMessage[] {
  let windowed = history.slice(-limit);
  while (windowed.length > 0 && windowed[0].role !== 'user') windowed = windowed.slice(1);
  return [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...windowed.map((m) => ({ role: m.role, content: m.content })),
  ];
}
