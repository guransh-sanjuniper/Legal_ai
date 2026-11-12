import type { AnalysisRequest, DetailLevel } from './types';

export const DETAIL_LEVELS: DetailLevel[] = ['brief', 'standard', 'detailed'];

// Detail level sets how long the clause summaries and overview points may be.
export const DETAILED_SUMMARY_SENTENCES: Record<DetailLevel, number> = { brief: 2, standard: 4, detailed: 7 };
export const PROSE_SENTENCES: Record<DetailLevel, number> = { brief: 1, standard: 2, detailed: 3 };
export const OVERVIEW_SENTENCES_PER_POINT: Record<DetailLevel, number> = { brief: 1, standard: 2, detailed: 3 };

export interface AnalysisRequestInput {
  matter?: string;
  detailLevel?: string;
  focus?: string;
  customPrompt?: string;
}

const MAX_MATTER = 200;
const MAX_FOCUS = 300;
const MAX_CUSTOM = 2000;

export function normaliseRequest(input?: AnalysisRequestInput): AnalysisRequest {
  const detail = DETAIL_LEVELS.includes(input?.detailLevel as DetailLevel)
    ? (input!.detailLevel as DetailLevel)
    : 'standard';
  return {
    matter: (input?.matter ?? '').trim().slice(0, MAX_MATTER),
    detailLevel: detail,
    focus: (input?.focus ?? '').trim().slice(0, MAX_FOCUS),
    customPrompt: (input?.customPrompt ?? '').trim().slice(0, MAX_CUSTOM),
  };
}
