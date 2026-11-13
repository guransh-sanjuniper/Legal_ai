export interface VerifiedItemBase {
  quote: string;
  page: number;
  verified: true;
}

export interface VerifiedObligation extends VerifiedItemBase {
  itemId: string;
  clause: string;
  party: string;
  text: string;
}

export interface VerifiedDate extends VerifiedItemBase {
  itemId: string;
  clause: string;
  text: string;
  // What the date is for. When empty, the quote is shown as the description.
  purpose?: string;
  timing_type: 'fixed' | 'event_relative' | 'none';
}

export interface VerifiedPayment extends VerifiedItemBase {
  itemId: string;
  clause: string;
  amount: string;
  // What the amount is for. When empty, the quote is shown as the description.
  purpose?: string;
  payer: string;
  payee: string;
  due: string;
}

export interface LawPassageRef {
  id: string;
  title: string;
  text: string;
  fused: number;
  lawVersion: string;
}

export type DetailLevel = 'brief' | 'standard' | 'detailed';

// Whose side the lawyer is reviewing for. It frames risk priorities and suggestions; it never
// limits what is reported.
export type ReviewingFor = 'licensor' | 'licensee' | 'neutral';

export type RiskBasis =
  | 'void_or_unenforceable'
  | 'illegal'
  | 'statutory_violation'
  | 'major_financial_exposure'
  | 'other';

export interface AnalysisRequest {
  matter: string;
  detailLevel: DetailLevel;
  focus: string;
  customPrompt: string;
  reviewingFor: ReviewingFor;
}

// `severity` holds the priority (high/medium/low). The report shows it as "Priority".
export interface VerifiedRisk extends VerifiedItemBase {
  itemId: string;
  clause: string;
  text: string;
  severity: 'high' | 'medium' | 'low';
  basis?: RiskBasis;
  suggestion?: string;
  laws?: string[];
  // Which party the term affects. Framed by the reviewing side, never limited by it.
  affects?: string;
  // Older saved reports used law-library passages. New reports leave this empty.
  lawPassages?: LawPassageRef[];
  applicability: 'unverified';
}

// Model-written clause text. Not quote-verified; the clause and page are cited by the parent item.
export interface ClauseProse {
  detailed_summary: string;
  conditions: string;
  exceptions: string;
  rights: string;
  legal_significance: string;
  ambiguity: string;
  suggested_action: string;
  location_mismatch: string;
}

export interface VerifiedClause {
  itemId: string;
  clauseNo: string;
  type: string;
  summary: string;
  chunkId: string;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  obligations: VerifiedObligation[];
  dates: VerifiedDate[];
  payments: VerifiedPayment[];
  risks: VerifiedRisk[];
  verifiedItems: number;
  missing?: string[];
  prose?: ClauseProse;
}

export interface MissingProtection {
  itemId: string;
  topic: string;
  text: string;
  severity: 'high' | 'medium' | 'low';
  basis: RiskBasis;
  suggestion: string;
  laws: string[];
  // Clause item IDs affected by the gap. Empty means the whole document.
  cites: string[];
  applicability: 'unverified';
}

export interface OverviewPoint {
  point: number;
  title: string;
  sentences: RollupSentence[];
  // Set when the point is assembled rather than written by the model.
  note?: string;
}

export interface PromptAnswer {
  itemId: string;
  text: string;
  clause: string;
  page: number;
  quote: string;
  verified: true;
  // The direct answer to the prompt, or a supporting quote. Answers come first.
  part?: 'answer' | 'support';
}

export interface PromptResult {
  prompt: string;
  // Chunk-level verified answers. Intermediate: kept for the supporting quotes.
  answers: PromptAnswer[];
  // Synthesis over the verified answers: the final answer in prose, citing answers.
  answer?: { text: string; cites: string[] }[];
  chunksTotal: number;
  chunksDone: number;
  failedChunks: { chunkIndex: number; pages: [number, number]; failureCode: string | null; message: string | null }[];
}

// Unfilled blanks and reviewer comments found in the source text by code, grouped by clause.
export interface DraftingIssueGroup {
  clause: string;
  page: number;
  blanks: string[];
  comments: string[];
}

export interface DraftingIssues {
  blankCount: number;
  commentCount: number;
  groups: DraftingIssueGroup[];
}

// Result of the validation pass over High and Medium risks.
export interface RiskReviewStats {
  reviewed: number;
  kept: number;
  downgraded: number;
  dropped: number;
  // Why each risk was dropped, for the dev-visible list.
  drops?: { clause: string; issue: string; reason: string }[];
}

// Missing-protection counts, so an empty list is explainable.
export interface MissingStats {
  proposed: number;
  kept: number;
  droppedCovered: number;
  // Kept, but the whole-document search failed or found nothing: shown apart, not as verified.
  possiblyMissing: number;
  passRan: boolean;
}

export interface SummaryStats {
  rawItems: number;
  kept: number;
  droppedByGuard: number;
}

export interface DropRecord {
  clauseNo: string;
  kind: string;
  reason: string;
  page: number | null;
  quote: string;
}

export interface RollupSentence {
  text: string;
  cites: string[];
}

export interface SectionSummary {
  section: number;
  itemIds: string[];
  sentences: RollupSentence[];
  dropped: number;
}

export interface CrossClauseResult {
  findings: { kind: string; text: string; itemIds: string[]; severity: string; reason?: string }[];
  payments: { payer: string; payee: string; count: number; amounts: string[]; numericTotal: number | null }[];
}

// A saved judgement is attached to the local report record so the quality suite can re-score
// favour recall without making another model call. It is optional: older reports do not have it.
export interface JudgementSnapshot {
  parties: { a: string | null; b: string | null };
  rows: {
    clause: string;
    page: number;
    quote: string;
    direction: 'favours_a' | 'favours_b' | 'neutral';
    why: string;
  }[];
}

export interface AnalysisMetrics {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  p95DurationMs: number;
  retried: number;
  split: number;
  failed: number;
  emptyOutput: number;
  totalTasks: number;
  doneTasks: number;
  p95CompletionTokens: number;
  recommendedMaxTokens: number | null;
  rateLimitEvents?: number;
  rateLimitWaitMs?: number;
  concurrency?: number;
}

export interface AnalysisReport {
  docId: string;
  docHash: string;
  docName: string;
  runId: string;
  createdAt: number;
  model: string;
  lawVersion: string;
  definitions: {
    parties: { name: string; role: string }[];
    defined_terms: { term: string; definition: string; clause: string | null; page: number | null }[];
    key_dates: { date: string; description: string; clause: string | null; page: number | null }[];
  };
  clauses: VerifiedClause[];
  overview: RollupSentence[];
  sections: SectionSummary[];
  crossClause: CrossClauseResult;
  ledger: import('./ledger').Ledger;
  metrics: AnalysisMetrics;
  drops: DropRecord[];
  amounts: {
    code: import('./amounts').ExtractedAmount[];
    uncaptured: import('./amounts').ExtractedAmount[];
  };
  resolution: { pageCorrected: number; dropped: number; skippedClauses: number };
  notices: string[];
  request?: AnalysisRequest;
  // Clause numbers that each analysis chunk contains. Used to place unnumbered entries.
  chunkClauses?: { chunkIndex: number; clauses: string[] }[];
  overviewPoints?: OverviewPoint[];
  missingProtections?: MissingProtection[];
  possiblyMissing?: MissingProtection[];
  missingStats?: MissingStats;
  riskReview?: RiskReviewStats;
  draftingIssues?: DraftingIssues;
  summaryStats?: SummaryStats;
  promptResult?: PromptResult;
  judgement?: JudgementSnapshot;
  partial?: boolean;
  unreliable?: boolean;
  failedClauses?: {
    taskId: string;
    clause: string;
    pages: [number, number];
    failureCode: string | null;
    message: string | null;
  }[];
  coverage?: {
    mode?: 'structure' | 'structure-free';
    totalClauses?: number;
    analysedClauses?: number;
    notAnalysed?: number;
    totalChunks?: number;
    analysedChunks?: number;
    totalPages?: number;
    pagesCovered?: number;
    failedChunks?: {
      chunkIndex: number;
      pages: [number, number];
      failureCode: string | null;
      message: string | null;
    }[];
  };
  dedupe?: {
    itemsBefore: number;
    itemsAfter: number;
    removed: number;
    clausesBefore: number;
    clausesAfter: number;
  };
  chunking?: {
    mode: 'structure' | 'structure-free';
    modeReason: string;
    chunkCount: number;
    longestChunkTokens: number;
    sectionBreaks: number;
    longClauses: number;
  };
}
