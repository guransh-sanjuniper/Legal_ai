import type { AnalysisRequest, DetailLevel, ReviewingFor } from './types';

export const DETAIL_LEVELS: DetailLevel[] = ['brief', 'standard', 'detailed'];
export const REVIEWING_FOR: ReviewingFor[] = ['licensor', 'licensee', 'neutral'];

// Detail level sets how long the clause summaries and overview points may be.
export const DETAILED_SUMMARY_SENTENCES: Record<DetailLevel, number> = { brief: 2, standard: 4, detailed: 7 };
export const PROSE_SENTENCES: Record<DetailLevel, number> = { brief: 1, standard: 2, detailed: 3 };
// Each overview point is a short paragraph: this is the base sentence count (plus up to 2).
export const OVERVIEW_SENTENCES_PER_POINT: Record<DetailLevel, number> = { brief: 3, standard: 4, detailed: 5 };

export interface AnalysisRequestInput {
  matter?: string;
  detailLevel?: string;
  focus?: string;
  customPrompt?: string;
  reviewingFor?: string;
}

const MAX_MATTER = 200;
const MAX_FOCUS = 300;
const MAX_CUSTOM = 2000;

export function normaliseRequest(input?: AnalysisRequestInput): AnalysisRequest {
  const detail = DETAIL_LEVELS.includes(input?.detailLevel as DetailLevel)
    ? (input!.detailLevel as DetailLevel)
    : 'standard';
  const reviewing = REVIEWING_FOR.includes(input?.reviewingFor as ReviewingFor)
    ? (input!.reviewingFor as ReviewingFor)
    : 'neutral';
  return {
    matter: (input?.matter ?? '').trim().slice(0, MAX_MATTER),
    detailLevel: detail,
    focus: (input?.focus ?? '').trim().slice(0, MAX_FOCUS),
    customPrompt: (input?.customPrompt ?? '').trim().slice(0, MAX_CUSTOM),
    reviewingFor: reviewing,
  };
}

// One line of framing for the prompts. It never narrows what is reported.
export function reviewingLine(reviewingFor: ReviewingFor): string {
  if (reviewingFor === 'neutral') return '';
  const party = reviewingFor === 'licensor' ? 'the licensor / owner side' : 'the licensee / occupier side';
  return `REVIEWING FOR: ${party}. Frame risk priorities and suggestions from that side's position. This frames the answer only; report every issue you find, including ones that favour the other side.`;
}
