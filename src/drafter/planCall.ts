import { ChatError, streamChat } from '../chat/stream';
import { DRAFTER_PLAN_MAX_TOKENS } from './config';
import { buildPlanInput, PLAN_SYSTEM_PROMPT, validatePlanOutput, type DocAlias } from './plan';
import type { DraftRecord, Particular, SourcePlan } from './types';

// One proxy call for the instruction parse. This uses the same direct ai-proxy path as chat
// (`streamChat`): no harness task, no run record, no writes to `pipeline-harness`. The reply is
// parsed only after it is complete; a reply cut at the output limit is never parsed.

export interface PlanStreamOptions {
  functionsUrl: string;
  anonKey: string;
  getToken: (force?: boolean) => Promise<string | null>;
  model: string;
  maxTokens: number;
  messages: { role: 'system' | 'user'; content: string }[];
  onDelta: (text: string) => void;
}

export type PlanStream = (opts: PlanStreamOptions) => Promise<{ text: string; finishReason: string }>;

export interface PlanCallDeps {
  functionsUrl: string;
  anonKey: string;
  getToken: (force?: boolean) => Promise<string | null>;
  model: string;
  maxTokens?: number;
  // Test hook: replace the proxy call without touching the chat client.
  stream?: PlanStream;
}

export type PlanCallResult =
  | { ok: true; plan: SourcePlan; particulars: Particular[]; dropped: number; raw: string }
  | { ok: false; code: string; message: string; raw: string };

export async function runPlanCall(
  deps: PlanCallDeps,
  draft: DraftRecord,
  docs: DocAlias[],
): Promise<PlanCallResult> {
  let raw = '';
  try {
    const stream: PlanStream = deps.stream ?? streamChat;
    const result = await stream({
      functionsUrl: deps.functionsUrl,
      anonKey: deps.anonKey,
      getToken: deps.getToken,
      model: deps.model,
      maxTokens: deps.maxTokens ?? DRAFTER_PLAN_MAX_TOKENS,
      messages: [
        { role: 'system', content: PLAN_SYSTEM_PROMPT },
        { role: 'user', content: buildPlanInput(draft, docs) },
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
        message: 'The reply was cut off at the output limit. Retry.',
        raw,
      };
    }

    const parsed = validatePlanOutput(raw, {
      instruction: draft.instruction,
      docs,
      model: deps.model,
    });
    if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message, raw };
    return { ok: true, plan: parsed.plan, particulars: parsed.particulars, dropped: parsed.dropped, raw };
  } catch (e) {
    const code = e instanceof ChatError ? e.code : 'network';
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code, message, raw };
  }
}
