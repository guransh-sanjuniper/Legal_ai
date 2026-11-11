import type { AnalysisReport } from '../analysis/types';
import { clauseMatch } from '../analysis/goldenScore';
import { quoteOverlap } from '../analysis/judgement';

export type RepeatKind = 'payment' | 'date' | 'obligation' | 'risk';

export interface VerifiedItemRef {
  kind: RepeatKind;
  clause: string;
  page: number;
  quote: string;
}

export interface RepeatOverlap {
  kind: RepeatKind;
  clauseFirst: string;
  clauseSecond: string;
  quote: string;
}

export interface RepeatComparison {
  first: { runId: string; doc: string; items: number };
  second: { runId: string; doc: string; items: number };
  overlap: RepeatOverlap[];
  onlyInFirst: VerifiedItemRef[];
  onlyInSecond: VerifiedItemRef[];
  counts: { first: number; second: number; overlap: number; onlyInFirst: number; onlyInSecond: number };
  byKind: Record<RepeatKind, { first: number; second: number; overlap: number; onlyInFirst: number; onlyInSecond: number }>;
}

const KINDS: RepeatKind[] = ['payment', 'date', 'obligation', 'risk'];

export function verifiedItems(report: AnalysisReport): VerifiedItemRef[] {
  const out: VerifiedItemRef[] = [];
  for (const c of report.clauses) {
    for (const p of c.payments) out.push({ kind: 'payment', clause: c.clauseNo, page: p.page, quote: p.quote });
    for (const d of c.dates) out.push({ kind: 'date', clause: c.clauseNo, page: d.page, quote: d.quote });
    for (const o of c.obligations) out.push({ kind: 'obligation', clause: c.clauseNo, page: o.page, quote: o.quote });
    for (const r of c.risks) out.push({ kind: 'risk', clause: c.clauseNo, page: r.page, quote: r.quote });
  }
  return out;
}

const emptyByKind = () =>
  Object.fromEntries(KINDS.map((k) => [k, { first: 0, second: 0, overlap: 0, onlyInFirst: 0, onlyInSecond: 0 }])) as Record<
    RepeatKind,
    { first: number; second: number; overlap: number; onlyInFirst: number; onlyInSecond: number }
  >;

// Two runs match an item when it has the same kind and clause and their quotes overlap. The
// comparison is one-to-one, so a quote repeated twice in one run cannot absorb two items.
export function compareRuns(first: AnalysisReport, second: AnalysisReport): RepeatComparison {
  const a = verifiedItems(first);
  const b = verifiedItems(second);
  const used = new Set<number>();
  const overlap: RepeatOverlap[] = [];
  const onlyInFirst: VerifiedItemRef[] = [];
  const onlyInSecond: VerifiedItemRef[] = [];
  const byKind = emptyByKind();

  for (const x of a) byKind[x.kind].first++;
  for (const x of b) byKind[x.kind].second++;

  for (const x of a) {
    const idx = b.findIndex(
      (y, i) => !used.has(i) && y.kind === x.kind && clauseMatch(x.clause, y.clause) && quoteOverlap(x.quote, y.quote),
    );
    if (idx >= 0) {
      used.add(idx);
      overlap.push({ kind: x.kind, clauseFirst: x.clause, clauseSecond: b[idx].clause, quote: x.quote });
      byKind[x.kind].overlap++;
    } else {
      onlyInFirst.push(x);
      byKind[x.kind].onlyInFirst++;
    }
  }
  for (let i = 0; i < b.length; i++) {
    if (!used.has(i)) {
      onlyInSecond.push(b[i]);
      byKind[b[i].kind].onlyInSecond++;
    }
  }

  return {
    first: { runId: first.runId, doc: first.docName, items: a.length },
    second: { runId: second.runId, doc: second.docName, items: b.length },
    overlap,
    onlyInFirst,
    onlyInSecond,
    counts: {
      first: a.length,
      second: b.length,
      overlap: overlap.length,
      onlyInFirst: onlyInFirst.length,
      onlyInSecond: onlyInSecond.length,
    },
    byKind,
  };
}

// Runs the supplied analysis twice and compares the verified items. The caller supplies the
// run (a paid call outside unit tests); this module never calls a model itself.
export async function runRepeatComparison(
  run: () => Promise<AnalysisReport>,
): Promise<{ first: AnalysisReport; second: AnalysisReport; comparison: RepeatComparison }> {
  const first = await run();
  const second = await run();
  return { first, second, comparison: compareRuns(first, second) };
}
