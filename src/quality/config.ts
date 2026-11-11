import type { QualityThresholds } from './types';

// Pass/fail thresholds for one scored run. Tune these, not the scorer. A missing kind
// (expected === 0) is never failed.
export const DEFAULT_THRESHOLDS: QualityThresholds = {
  paymentRecallModel: 0.5,
  paymentRecallCombined: 0.8,
  dateRecall: 0.6,
  obligationRecall: 0.6,
  riskRecall: 0.5,
  favourRecall: 0.6,
  precision: 0.85,
  quoteValidity: 1,
  maxFalseMissingClaims: 0,
  overviewFidelity: 0.9,
  maxFailedTasks: 2,
  ledgerMustMatch: true,
};
