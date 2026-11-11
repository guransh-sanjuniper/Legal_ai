import type { AnalysisReport, VerifiedPayment } from './types';
import type { ExtractedAmount } from './amounts';
import { parseMoney } from './amounts';
import { canonicalClause, looksLikeDeveloperObligation, type JudgementRow } from './judgement';

export interface GoldenPayment {
  clause: string;
  label: string;
  amount?: number;
  percent?: number;
  keyword?: string;
}

export interface PaymentScore {
  expected: number;
  modelFound: number;
  combinedFound: number;
  modelRecall: number;
  combinedRecall: number;
  modelMisses: GoldenPayment[];
  combinedMisses: GoldenPayment[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const topOfClause = (c: string) => canonicalClause(c).replace(/\(.*$/, '');

function paymentMatches(
  item: GoldenPayment,
  clause: string,
  amountText: string,
  quote: string,
  due: string,
  numeric: number | null,
  summary = '',
): boolean {
  // Payments can sit under a sub-item (16(a)); the golden expectation is the clause.
  if (topOfClause(clause) !== topOfClause(item.clause)) return false;
  const haystack = `${amountText} ${quote} ${due} ${summary}`;
  if (item.keyword && !norm(haystack).includes(norm(item.keyword))) return false;
  if (item.amount !== undefined) {
    const n = numeric ?? parseMoney(amountText);
    if (n === null || Math.abs(n - item.amount) > 0.01) return false;
  }
  if (item.percent !== undefined) {
    const m = /(\d+(?:\.\d+)?)\s*%/.exec(`${amountText} ${quote} ${due}`);
    if (!m || Math.abs(Number(m[1]) - item.percent) > 0.01) return false;
  }
  if (item.amount === undefined && item.percent === undefined && !item.keyword) return false;
  return true;
}

export function scorePayments(
  report: Pick<AnalysisReport, 'clauses' | 'amounts'>,
  expected: GoldenPayment[],
): PaymentScore {
  const payments: VerifiedPayment[] = report.clauses.flatMap((c) => c.payments);
  const code: ExtractedAmount[] = (report.amounts?.code ?? []).filter(
    (a) => !a.text.includes('\n') && a.text.trim().length > 2,
  );
  const summaryByClause = new Map<string, string>();
  for (const c of report.clauses) {
    const top = topOfClause(c.clauseNo);
    summaryByClause.set(top, `${summaryByClause.get(top) ?? ''} ${c.summary}`);
  }

  const modelHit = (g: GoldenPayment) =>
    report.clauses.some((c) =>
      c.payments.some((p) =>
        paymentMatches(g, c.clauseNo, p.amount, p.quote, p.due, parseMoney(p.amount), c.summary),
      ),
    );
  const combinedHit = (g: GoldenPayment) =>
    modelHit(g) ||
    code.some((a) =>
      paymentMatches(
        g,
        a.clause,
        a.text,
        a.quote,
        '',
        // Percentages are matched from their text; durations only help keyword expectations.
        a.kind === 'money' ? a.numeric : null,
        summaryByClause.get(topOfClause(a.clause)) ?? '',
      ),
    );

  const modelMisses = expected.filter((g) => !modelHit(g));
  const combinedMisses = expected.filter((g) => !combinedHit(g));
  const modelFound = expected.length - modelMisses.length;
  const combinedFound = expected.length - combinedMisses.length;

  return {
    expected: expected.length,
    modelFound,
    combinedFound,
    modelRecall: expected.length ? modelFound / expected.length : 0,
    combinedRecall: expected.length ? combinedFound / expected.length : 0,
    modelMisses,
    combinedMisses,
  };
}

export interface FavourScore {
  expected: number;
  found: number;
  recall: number;
  misses: string[];
  falseFavours: { clause: string; quote: string; why: string }[];
}

function clauseMatches(expected: string, actual: string): boolean {
  return canonicalClause(expected) === canonicalClause(actual);
}

export function scoreDeveloperFavour(rows: JudgementRow[], expected: string[]): FavourScore {
  const developerRows = rows.filter((r) => r.direction === 'favours_developer');
  const found = expected.filter((e) => developerRows.some((r) => clauseMatches(e, r.clause)));
  const misses = expected.filter((e) => !found.includes(e));
  const falseFavours = rows
    .filter((r) => r.direction === 'favours_developer' && looksLikeDeveloperObligation(r.quote, r.why))
    .map((r) => ({ clause: r.clause, quote: r.quote, why: r.why }));
  return {
    expected: expected.length,
    found: found.length,
    recall: expected.length ? found.length / expected.length : 0,
    misses,
    falseFavours,
  };
}
