import type { VerifiedClause, VerifiedItemBase } from './types';
import { quoteOverlap } from './judgement';

export interface DedupeStats {
  itemsBefore: number;
  itemsAfter: number;
  removed: number;
  clausesBefore: number;
  clausesAfter: number;
}

type ItemList = VerifiedItemBase[];

// Verified items repeated across overlapping chunks are kept once. A duplicate is the same kind,
// on the same page, with an equal or heavily overlapping quote.
export function dedupeVerifiedClauses(
  clauses: VerifiedClause[],
  opts: { dropEmpty?: boolean } = {},
): { clauses: VerifiedClause[]; stats: DedupeStats } {
  const seen: Record<'obligation' | 'date' | 'payment' | 'risk', ItemList> = {
    obligation: [],
    date: [],
    payment: [],
    risk: [],
  };
  let itemsBefore = 0;
  let removed = 0;
  const out: VerifiedClause[] = [];

  const keep = <T extends VerifiedItemBase>(kind: keyof typeof seen, items: T[]): T[] => {
    const kept: T[] = [];
    for (const item of items) {
      itemsBefore++;
      const duplicate = seen[kind].some((x) => x.page === item.page && quoteOverlap(x.quote, item.quote));
      if (duplicate) {
        removed++;
        continue;
      }
      seen[kind].push(item);
      kept.push(item);
    }
    return kept;
  };

  for (const clause of clauses) {
    const obligations = keep('obligation', clause.obligations);
    const dates = keep('date', clause.dates);
    const payments = keep('payment', clause.payments);
    const risks = keep('risk', clause.risks);
    const verifiedItems = obligations.length + dates.length + payments.length + risks.length;
    if (opts.dropEmpty && verifiedItems === 0) continue;
    out.push({ ...clause, obligations, dates, payments, risks, verifiedItems });
  }

  return {
    clauses: out,
    stats: {
      itemsBefore,
      itemsAfter: itemsBefore - removed,
      removed,
      clausesBefore: clauses.length,
      clausesAfter: out.length,
    },
  };
}
