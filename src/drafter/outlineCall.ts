import { ChatError, streamChat } from '../chat/stream';
import { DRAFTER_OUTLINE_MAX_TOKENS } from './config';
import { buildOutlineInput, OUTLINE_SYSTEM_PROMPT, planFingerprint, validateOutlineOutput } from './outline';
import type { PlanStream } from './planCall';
import type { DocAlias } from './plan';
import type { RefStructure } from './refStructure';
import type { DraftRecord, Outline } from './types';

// One proxy call for the outline, on the same direct ai-proxy path as chat and the plan call.
// No harness task, no run record, no writes to `pipeline-harness`. A reply cut at the output
// limit is never parsed.

export interface OutlineCallDeps {
  functionsUrl: string;
  anonKey: string;
  getToken: (force?: boolean) => Promise<string | null>;
  model: string;
  maxTokens?: number;
  // Test hook: replace the proxy call without touching the chat client.
  stream?: PlanStream;
}

export type OutlineCallResult =
  | { ok: true; outline: Outline; dropped: number; duplicates: string[]; raw: string }
  | { ok: false; code: string; message: string; raw: string };

export async function runOutlineCall(
  deps: OutlineCallDeps,
  draft: DraftRecord,
  docs: DocAlias[],
  structures: RefStructure[],
  feedback?: string,
  previous?: Outline | null,
): Promise<OutlineCallResult> {
  let raw = '';
  try {
    const stream: PlanStream = deps.stream ?? streamChat;
    const result = await stream({
      functionsUrl: deps.functionsUrl,
      anonKey: deps.anonKey,
      getToken: deps.getToken,
      model: deps.model,
      maxTokens: deps.maxTokens ?? DRAFTER_OUTLINE_MAX_TOKENS,
      messages: [
        { role: 'system', content: OUTLINE_SYSTEM_PROMPT },
        { role: 'user', content: buildOutlineInput(draft, docs, structures, feedback, previous) },
      ],
      onDelta: (text) => {
        raw += text;
      },
    });
    if (result.text) raw = result.text;

    if (result.finishReason === 'length') {
      return {
        ok: false,
        code: 'length',
        message: 'The outline was too long to finish. Try again.',
        raw,
      };
    }

    const parsed = validateOutlineOutput(raw, {
      bindings: draft.sourcePlan?.bindings ?? [],
      model: deps.model,
      planFingerprint: planFingerprint(draft),
      feedback,
    });
    if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message, raw };
    return {
      ok: true,
      outline: parsed.outline,
      dropped: parsed.dropped,
      duplicates: parsed.duplicates,
      raw,
    };
  } catch (e) {
    const code = e instanceof ChatError ? e.code : 'network';
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code, message, raw };
  }
}
