import { DEEP_PROMPT_EVIDENCE_CHUNKS, DEEP_PROMPT_MAX_PARTS } from './config';
import { conceptOf, requestConcepts } from './questionTerms';

// Pure helpers for the Deep Analysis Prompt Result. The chat path never calls them.
// The request is split into the user's own parts, sized for one answer call each. The rules are
// conservative: a request is only split where a person would read a new question, so a term like
// "rent and deposit" stays one part.

export type PromptKind = 'narrow' | 'standard' | 'broad' | 'list';

export interface PromptPartRef {
  // The user's own wording, used as the heading. Null when the request has a single part, because
  // the section already prints the prompt above the answer.
  heading: string | null;
  text: string;
}

export interface PromptDepth {
  parts: PromptPartRef[];
  kind: PromptKind;
  // Output budget for one part's answer.
  maxAnswerTokens: number;
  // Extra sections the coverage pass may read. 0 means no extra reading (and no extra calls).
  breadth: number;
}

export const PROMPT_ANSWER_TOKENS: Record<PromptKind, number> = {
  narrow: 800,
  standard: 2000,
  broad: 3000,
  list: 3000,
};

const NARROW_MAX_WORDS = 20;
const MIN_PART_WORDS = 3;
const MAX_HEADING_CHARS = 160;
export const PROMPT_OVERFLOW_HEADING = 'Other parts of your request';

const LIST_CUE =
  /\b(list all|list every|list the|all the|every|each of|enumerate|identify all|name all|which clauses|which sections|set out all)\b/i;
const BROAD_CUE =
  /\b(explain|summari[sz]e|summary|analyse|analyze|analysis|describe|review|assess|overview|walk me through|what are)\b/i;

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

export function classifyPrompt(request: string): PromptKind {
  const text = request.trim();
  if (!text) return 'narrow';
  if (LIST_CUE.test(text)) return 'list';
  if (BROAD_CUE.test(text)) return 'broad';
  if (wordCount(text) <= NARROW_MAX_WORDS) return 'narrow';
  return 'standard';
}

// Splits on a blank/newline list item, a question mark, or a semicolon followed by a new question.
// Never on "and"/"or": those usually join one subject, not two questions.
export function splitPromptParts(request: string, maxParts = DEEP_PROMPT_MAX_PARTS): PromptPartRef[] {
  const text = request.replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  // 1. Newline list items start a new part; a plain newline continues the current one.
  const lines = text.split('\n');
  const segments: string[] = [];
  let current = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const item = /^(?:\d+[.)]|[-*•])\s+(.*)$/.exec(trimmed);
    if (item) {
      const next = item[1].trim();
      if (current.trim()) segments.push(current.trim());
      current = next;
      continue;
    }
    current = current ? `${current} ${trimmed}` : trimmed;
  }
  if (current.trim()) segments.push(current.trim());

  // 2. Within a segment, a question mark or a semicolon before a new question starts a new part.
  const pieces: string[] = [];
  for (const segment of segments) {
    const split = segment
      .replace(/\?\s+(?=[A-Z0-9(])/g, '?\u0000')
      .replace(/;\s+(?=(?:what|which|who|whom|whose|when|where|why|how|list|explain|summari[sz]e|describe|identify|state)\b)/gi, ';\u0000')
      .split('\u0000');
    for (const piece of split) {
      const trimmed = piece.trim().replace(/;$/, '').trim();
      if (trimmed) pieces.push(trimmed);
    }
  }

  // 3. A very short fragment joins the part before it (or the one after it when it leads).
  const merged: string[] = [];
  for (const piece of pieces) {
    if (wordCount(piece) < MIN_PART_WORDS && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${piece}`.trim();
      continue;
    }
    merged.push(piece);
  }
  if (merged.length > 1 && wordCount(merged[0]) < MIN_PART_WORDS) {
    merged[1] = `${merged[0]} ${merged[1]}`.trim();
    merged.shift();
  }
  const parts = merged.length > 0 ? merged : [text];

  // 4. Cap the number of calls; the rest are answered together under a plain heading.
  const capped =
    parts.length > maxParts
      ? [
          ...parts.slice(0, Math.max(1, maxParts - 1)),
          `${PROMPT_OVERFLOW_HEADING}: ${parts.slice(Math.max(1, maxParts - 1)).join(' ')}`,
        ]
      : parts;

  const single = capped.length === 1;
  return capped.map((part) => {
    const overflow = part.startsWith(`${PROMPT_OVERFLOW_HEADING}:`) && parts.length > maxParts;
    const body = overflow ? part.slice(PROMPT_OVERFLOW_HEADING.length + 1).trim() : part;
    return {
      heading: single ? null : overflow ? PROMPT_OVERFLOW_HEADING : part.slice(0, MAX_HEADING_CHARS),
      text: body,
    };
  });
}

// How deep the answer may go, from the request alone. No model call: the same request always gives
// the same parts and the same caps, so a resume re-uses its tasks.
export function promptDepth(request: string): PromptDepth {
  const kind = classifyPrompt(request);
  return {
    parts: splitPromptParts(request),
    kind,
    maxAnswerTokens: PROMPT_ANSWER_TOKENS[kind],
    breadth: kind === 'broad' || kind === 'list' ? DEEP_PROMPT_EVIDENCE_CHUNKS : 0,
  };
}

// The part a quote the deterministic guard rejected most likely belongs to, by how many of the
// part's concepts the quote carries. Ties go to the earliest part; no concepts keeps the first part.
export function partForQuote(quote: string, parts: PromptPartRef[]): number {
  if (parts.length <= 1) return 0;
  const have = new Set(words(quote).map(conceptOf));
  let best = 0;
  let bestScore = 0;
  parts.forEach((part, i) => {
    const needed = requestConcepts(part.text);
    const score = needed.filter((concept) => have.has(concept)).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

// Removes any item id the model wrote into the answer text. Only known ids are removed, so a real
// word or number in the sentence is never touched. The numbered markers are added by code.
export function stripAnswerIds(text: string, knownIds: Iterable<string>): string {
  let out = text;
  for (const id of knownIds) {
    if (!id) continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out
      .replace(new RegExp(`\\s*[\\[(]\\s*${escaped}\\s*[\\])]`, 'gi'), '')
      .replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'gi'), '');
  }
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}
