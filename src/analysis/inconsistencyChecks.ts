import type { VerifiedClause, VerifiedRisk } from './types';
import type { CrossFinding } from './crossClause';

// Internal inconsistencies. Every finding needs two verified quotes and one line of reason, and a
// shared subject and party. These are checks to run, not findings to produce: an empty result is
// normal.

interface Evidence {
  clause: string;
  itemId: string;
  quote: string;
  party: string;
  page: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const partyKey = (s: string) => norm(s).replace(/\b(the|a|an|party|parties)\b/g, '').trim();

function evidenceOf(clauses: VerifiedClause[]): Evidence[] {
  const out: Evidence[] = [];
  for (const c of clauses) {
    for (const o of c.obligations) out.push({ clause: c.clauseNo, itemId: o.itemId, quote: o.quote, party: o.party, page: o.page });
    for (const r of c.risks) out.push({ clause: c.clauseNo, itemId: r.itemId, quote: r.quote, party: r.affects ?? '', page: r.page });
  }
  return out;
}

function partyCompatible(a: Evidence[], b: Evidence[]): boolean {
  const ka = new Set(a.map((x) => partyKey(x.party)).filter(Boolean));
  const kb = new Set(b.map((x) => partyKey(x.party)).filter(Boolean));
  if (ka.size === 0 && kb.size === 0) return true;
  for (const k of ka) if (kb.has(k)) return true;
  return false;
}

// Pairs two evidence sets that live in different clauses, share a subject, and share a party.
function pair(differentClauses: Evidence[], other: Evidence[], reason: (a: Evidence, b: Evidence) => string): CrossFinding[] {
  const findings: CrossFinding[] = [];
  for (const a of differentClauses) {
    for (const b of other) {
      if (a.clause === b.clause) continue;
      if (!partyCompatible([a], [b])) continue;
      if (findings.some((f) => f.itemIds.includes(a.itemId) && f.itemIds.includes(b.itemId))) continue;
      findings.push({
        kind: 'contradiction',
        text: `Clause ${a.clause} and clause ${b.clause} conflict.`,
        itemIds: [a.itemId, b.itemId],
        severity: 'medium',
        reason: reason(a, b),
      });
    }
  }
  return findings;
}

const matchAny = (items: Evidence[], re: RegExp) => items.filter((e) => re.test(e.quote));

export function findInconsistencies(clauses: VerifiedClause[]): CrossFinding[] {
  const ev = evidenceOf(clauses);
  const findings: CrossFinding[] = [];

  // 1. An irrevocable or non-terminable grant against a termination right.
  findings.push(
    ...pair(
      matchAny(ev, /irrevocab|non[- ]terminable|not be terminated|cannot be terminated|perpetual/i),
      matchAny(ev, /may terminate|right to terminate|terminate (this|the) agreement|termination/i),
      (a, b) =>
        `Clause ${a.clause} grants a right that cannot be withdrawn, while clause ${b.clause} allows termination of the same arrangement.`,
    ),
  );

  // 2. Arbitration against exclusive court jurisdiction.
  findings.push(
    ...pair(
      matchAny(ev, /arbitrat/i),
      matchAny(ev, /exclusive jurisdiction|courts? (?:at|of|in) [A-Za-z]|sole jurisdiction/i),
      (a, b) => `Clause ${a.clause} sends disputes to arbitration, while clause ${b.clause} gives exclusive court jurisdiction.`,
    ),
  );

  // 3. Two different guarantees or deposits for one purpose.
  const deposits = matchAny(ev, /(security )?deposit|guarantee/i);
  findings.push(
    ...pair(
      deposits,
      deposits.filter((d) => /(security )?deposit|guarantee/i.test(d.quote)),
      (a, b) =>
        `Clause ${a.clause} and clause ${b.clause} each create a deposit or guarantee for the same purpose with different terms.`,
    ),
  );

  // 4. Clause text against a table figure: the same clause states two different numbers for one subject.
  for (const c of clauses) {
    const nums = new Map<string, Evidence[]>();
    for (const o of c.obligations) {
      const amounts = o.quote.match(/(?:rs\.?|inr|₹)\s?[\d,]+|[\d,]+\s?(?:per cent|%)/gi) ?? [];
      for (const amount of amounts) {
        const key = norm(amount).replace(/\s/g, '');
        nums.set(key, [...(nums.get(key) ?? []), { clause: c.clauseNo, itemId: o.itemId, quote: o.quote, party: o.party, page: o.page }]);
      }
    }
    const keys = [...nums.keys()];
    if (keys.length > 1) {
      const a = nums.get(keys[0])![0];
      const b = nums.get(keys[1])![0];
      findings.push({
        kind: 'contradiction',
        text: `Clause ${c.clauseNo} states two different figures (${keys[0]} and ${keys[1]}) for the same subject.`,
        itemIds: [a.itemId, b.itemId],
        severity: 'medium',
        reason: 'Two figures appear in one clause; the operative text and the table must agree.',
      });
    }
  }

  // 5. Two different notice or time periods for termination.
  const periods = ev
    .map((e) => ({ ...e, days: /(\d{1,3})\s*(?:days?|weeks?|months?)/i.exec(e.quote) }))
    .filter((e) => e.days && /terminat|notice/i.test(e.quote));
  for (let i = 0; i < periods.length; i++) {
    for (let j = i + 1; j < periods.length; j++) {
      const a = periods[i];
      const b = periods[j];
      if (a.clause === b.clause || a.days![0] === b.days![0] || !partyCompatible([a], [b])) continue;
      findings.push({
        kind: 'contradiction',
        text: `Clause ${a.clause} and clause ${b.clause} state different notice periods (${a.days![0]} and ${b.days![0]}).`,
        itemIds: [a.itemId, b.itemId],
        severity: 'medium',
        reason: 'The same notice is given two different periods.',
      });
    }
  }

  return findings;
}
