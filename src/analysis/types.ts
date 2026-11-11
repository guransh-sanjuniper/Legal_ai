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
  timing_type: 'fixed' | 'event_relative' | 'none';
}

export interface VerifiedPayment extends VerifiedItemBase {
  itemId: string;
  clause: string;
  amount: string;
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

export interface VerifiedRisk extends VerifiedItemBase {
  itemId: string;
  clause: string;
  text: string;
  severity: 'high' | 'medium' | 'low';
  lawPassages: LawPassageRef[];
  applicability: 'unverified';
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
  findings: { kind: string; text: string; itemIds: string[]; severity: string }[];
  payments: { payer: string; payee: string; count: number; amounts: string[]; numericTotal: number | null }[];
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
}
