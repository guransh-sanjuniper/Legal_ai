import type { AnalysisReport } from './types';
import type { ExtractedAmount } from './amounts';
import { canonicalClause, type JudgementRow, type Parties } from './judgement';

// tests/golden/<docname>.json. "kind" is "payment" or "favour". For a payment, "token" must appear
// in the payment's amount, quote, due text or clause summary. For a favour, "token" must appear
// in the name of the party the row favours.
export interface GoldenExpectation {
  clause: string;
  token: string;
  kind: 'payment' | 'favour';
}

export interface GoldenFile {
  document?: string;
  holdout?: boolean;
  expected: GoldenExpectation[];
}

// Holdout files are kept out of the tuning report so they are not tuned against.
export function isTuningGolden(file: GoldenFile): boolean {
  return file.holdout !== true;
}

const topOf = (c: string) => canonicalClause(c).replace(/\(.*$/, '');
// A bare clause expectation matches any sub-item of it; a sub-item expectation needs that sub-item.
export const clauseMatch = (expected: string, actual: string) =>
  expected.includes('(') ? canonicalClause(expected) === canonicalClause(actual) : topOf(expected) === topOf(actual);
// Case-insensitive, without spaces or thousands separators, so "18,000", "18000" and "18.000" match.
export const normToken = (s: string) =>
  s.toLowerCase().replace(/(\d)\.(\d{3})(?!\d)/g, '$1$2').replace(/[,\s]/g, '');

export interface PaymentScore {
  expected: number;
  modelFound: number;
  combinedFound: number;
  modelRecall: number;
  combinedRecall: number;
  modelMisses: GoldenExpectation[];
  combinedMisses: GoldenExpectation[];
}

export function scorePayments(
  report: Pick<AnalysisReport, 'clauses' | 'amounts'>,
  expected: GoldenExpectation[],
): PaymentScore {
  const payments = expected.filter((e) => e.kind === 'payment');
  const code: ExtractedAmount[] = (report.amounts?.code ?? []).filter(
    (a) => !a.text.includes('\n') && a.text.trim().length > 2,
  );

  const modelHit = (g: GoldenExpectation) =>
    report.clauses.some(
      (c) =>
        clauseMatch(g.clause, c.clauseNo) &&
        c.payments.some((p) =>
          normToken(`${p.amount} ${p.quote} ${p.due} ${c.summary}`).includes(normToken(g.token)),
        ),
    );
  const combinedHit = (g: GoldenExpectation) =>
    modelHit(g) ||
    code.some(
      (a) =>
        clauseMatch(g.clause, a.clause) &&
        normToken(`${a.text} ${a.quote}`).includes(normToken(g.token)),
    );

  const modelMisses = payments.filter((g) => !modelHit(g));
  const combinedMisses = payments.filter((g) => !combinedHit(g));
  const modelFound = payments.length - modelMisses.length;
  const combinedFound = payments.length - combinedMisses.length;
  return {
    expected: payments.length,
    modelFound,
    combinedFound,
    modelRecall: payments.length ? modelFound / payments.length : 0,
    combinedRecall: payments.length ? combinedFound / payments.length : 0,
    modelMisses,
    combinedMisses,
  };
}

export interface FavourScore {
  expected: number;
  found: number;
  recall: number;
  misses: GoldenExpectation[];
  falseFavours: { clause: string; quote: string; why: string; party: string | null }[];
}

// A favour is found when a favouring row sits in the expected clause and names the expected party.
export function scoreFavours(rows: JudgementRow[], expected: GoldenExpectation[], parties: Parties): FavourScore {
  const favours = expected.filter((e) => e.kind === 'favour');
  const partyName = (r: JudgementRow) =>
    r.direction === 'favours_a' ? parties.a : r.direction === 'favours_b' ? parties.b : null;
  const hit = (g: GoldenExpectation) =>
    rows.some(
      (r) =>
        r.direction !== 'neutral' &&
        clauseMatch(g.clause, r.clause) &&
        (partyName(r) ?? '').toLowerCase().includes(g.token.toLowerCase()),
    );
  const misses = favours.filter((g) => !hit(g));
  return {
    expected: favours.length,
    found: favours.length - misses.length,
    recall: favours.length ? (favours.length - misses.length) / favours.length : 0,
    misses,
    falseFavours: rows
      .filter((r) => r.direction !== 'neutral' && !favours.some((g) => clauseMatch(g.clause, r.clause)))
      .map((r) => ({ clause: r.clause, quote: r.quote, why: r.why, party: partyName(r) })),
  };
}
