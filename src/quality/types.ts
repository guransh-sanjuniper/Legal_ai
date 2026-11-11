import type { GoldenExpectation, GoldenKind } from '../analysis/goldenScore';

// Kinds that can appear in a golden file. Recall is reported for each one.
export type ScoreableKind = GoldenKind;

export interface RecallResult {
  kind: ScoreableKind;
  expected: number;
  modelFound: number;
  combinedFound: number;
  modelRecall: number;
  combinedRecall: number;
  // False when the saved run has no judgement snapshot, so favour recall cannot be measured.
  available: boolean;
  modelMisses: GoldenExpectation[];
  combinedMisses: GoldenExpectation[];
}

export interface PrecisionBucket {
  shown: number;
  onList: number;
  precision: number;
}

export interface PrecisionResult {
  byKind: Record<ScoreableKind, PrecisionBucket>;
  overall: PrecisionBucket;
}

export type InvalidQuoteReason = 'page_missing' | 'page_mismatch' | 'not_found';

export interface InvalidQuote {
  kind: string;
  clause: string;
  page: number | null;
  quote: string;
  reason: InvalidQuoteReason;
  foundPage?: number;
}

export interface QuoteValidity {
  total: number;
  valid: number;
  rate: number;
  invalid: InvalidQuote[];
}

export interface FalseMissingClaim {
  text: string;
  topic: string;
  foundOnPage: number;
}

export interface FalseMissingCheck {
  claims: number;
  falseClaims: FalseMissingClaim[];
  rate: number;
}

export interface LedgerCheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface LedgerCheck {
  ok: boolean;
  checks: LedgerCheckItem[];
  mismatches: string[];
}

export interface OverviewIssue {
  text: string;
  cites: string[];
  unknownCites: string[];
  unsupportedFigures: string[];
}

export interface OverviewCheck {
  sentences: number;
  okSentences: number;
  rate: number;
  issues: OverviewIssue[];
}

export interface ScoreMetrics {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  p95DurationMs: number;
  failed: number;
  doneTasks: number;
  totalTasks: number;
}

export interface DocumentScore {
  doc: string;
  runId: string;
  model: string;
  createdAt: number;
  holdout: boolean;
  expected: number;
  recall: Record<ScoreableKind, RecallResult>;
  precision: PrecisionResult;
  quoteValidity: QuoteValidity;
  falseMissing: FalseMissingCheck;
  ledger: LedgerCheck;
  overview: OverviewCheck;
  metrics: ScoreMetrics;
  pass: boolean;
  failures: string[];
}

export interface QualityThresholds {
  paymentRecallModel: number;
  paymentRecallCombined: number;
  dateRecall: number;
  obligationRecall: number;
  riskRecall: number;
  favourRecall: number;
  precision: number;
  quoteValidity: number;
  maxFalseMissingClaims: number;
  overviewFidelity: number;
  maxFailedTasks: number;
  ledgerMustMatch: boolean;
}

export interface AggregateBucket {
  documents: number;
  expected: number;
  modelFound: number;
  combinedFound: number;
  recall: { model: number; combined: number };
  byKind: Record<ScoreableKind, { expected: number; modelFound: number; combinedFound: number }>;
  precision: number;
  quoteValidity: number;
  falseMissingClaims: number;
  overviewFidelity: number;
  failedTasks: number;
  calls: number;
  costUsd: number;
  passed: number;
}

export interface AggregateScore {
  tuning: AggregateBucket;
  holdout: AggregateBucket;
}
