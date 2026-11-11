import type { DocumentScore, ScoreableKind } from './types';

export const QUALITY_HISTORY_KEY = 'pipeline-quality-scores-v1';

export interface StoredScore {
  key: string;
  savedAt: number;
  score: DocumentScore;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadHistory(storage: StorageLike): StoredScore[] {
  try {
    const raw = storage.getItem(QUALITY_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is StoredScore =>
        typeof x === 'object' && x !== null && typeof (x as StoredScore).key === 'string' && !!(x as StoredScore).score,
    );
  } catch {
    return [];
  }
}

// One entry per run. Re-scoring the same run replaces its stored score instead of appending.
export function saveScore(storage: StorageLike, score: DocumentScore, now = Date.now()): StoredScore[] {
  const entries = loadHistory(storage);
  const key = `${score.doc}|${score.runId}`;
  const next = entries.filter((e) => e.key !== key);
  next.push({ key, savedAt: now, score });
  next.sort((a, b) => a.savedAt - b.savedAt);
  const capped = next.slice(-200);
  storage.setItem(QUALITY_HISTORY_KEY, JSON.stringify(capped));
  return capped;
}

// The last stored run for the same document, excluding the run being compared.
export function previousScore(entries: StoredScore[], score: DocumentScore): StoredScore | null {
  const candidates = entries.filter((e) => e.score.doc === score.doc && e.score.runId !== score.runId);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.savedAt - a.savedAt)[0];
}

export interface ScoreDelta {
  modelRecall: number;
  combinedRecall: number;
  byKind: Partial<Record<ScoreableKind, number>>;
  precision: number;
  quoteValidity: number;
  overviewFidelity: number;
  falseMissingClaims: number;
  failedTasks: number;
  costUsd: number;
  pass: 'improved' | 'worsened' | 'same';
}

const weightedRecall = (expected: number, found: number) => (expected === 0 ? 1 : found / expected);

export function compareScores(previous: DocumentScore, current: DocumentScore): ScoreDelta {
  const kinds: ScoreableKind[] = ['payment', 'date', 'obligation', 'favour', 'risk'];
  const byKind: Partial<Record<ScoreableKind, number>> = {};
  for (const kind of kinds) {
    const a = previous.recall[kind];
    const b = current.recall[kind];
    if (a.available && b.available && (a.expected > 0 || b.expected > 0)) {
      byKind[kind] = weightedRecall(b.expected, b.modelFound) - weightedRecall(a.expected, a.modelFound);
    }
  }
  const expectedSum = (s: DocumentScore) =>
    kinds.reduce((n, k) => n + (s.recall[k].available ? s.recall[k].expected : 0), 0);
  const foundSum = (s: DocumentScore) =>
    kinds.reduce((n, k) => n + (s.recall[k].available ? s.recall[k].modelFound : 0), 0);
  const combinedSum = (s: DocumentScore) =>
    kinds.reduce((n, k) => n + (s.recall[k].available ? s.recall[k].combinedFound : 0), 0);
  return {
    modelRecall:
      weightedRecall(expectedSum(current), foundSum(current)) - weightedRecall(expectedSum(previous), foundSum(previous)),
    combinedRecall:
      weightedRecall(expectedSum(current), combinedSum(current)) -
      weightedRecall(expectedSum(previous), combinedSum(previous)),
    byKind,
    precision: current.precision.overall.precision - previous.precision.overall.precision,
    quoteValidity: current.quoteValidity.rate - previous.quoteValidity.rate,
    overviewFidelity: current.overview.rate - previous.overview.rate,
    falseMissingClaims: current.falseMissing.falseClaims.length - previous.falseMissing.falseClaims.length,
    failedTasks: current.metrics.failed - previous.metrics.failed,
    costUsd: current.metrics.costUsd - previous.metrics.costUsd,
    pass:
      current.pass === previous.pass
        ? 'same'
        : current.pass
          ? 'improved'
          : 'worsened',
  };
}
