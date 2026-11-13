import type { VerifiedClause } from './types';
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

// Pairs two evidence sets that live in different clauses and share a party.
function pair(a: Evidence, b: Evidence, reason: string): CrossFinding {
  return {
    kind: 'contradiction',
    text: `Clause ${a.clause} and clause ${b.clause} conflict.`,
    itemIds: [a.itemId, b.itemId],
    severity: 'medium',
    reason,
  };
}

const matchAny = (items: Evidence[], re: RegExp) => items.filter((e) => re.test(e.quote));

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'for', 'by', 'at', 'in', 'on', 'as', 'per', 'with']);

function subjectBefore(quote: string, at: number): string {
  const words = quote
    .slice(0, at)
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/);
  return words
    .slice(-4)
    .filter((w) => w && !STOP.has(w.toLowerCase()))
    .join(' ')
    .toLowerCase();
}

export function findInconsistencies(clauses: VerifiedClause[]): CrossFinding[] {
  const ev = evidenceOf(clauses);
  const findings: CrossFinding[] = [];

  // 1. An irrevocable or non-terminable grant against a termination right.
  for (const a of matchAny(ev, /irrevocab|non[- ]terminable|not be terminated|cannot be terminated|perpetual/i)) {
    for (const b of matchAny(ev, /may terminate|right to terminate|terminate (this|the) agreement|termination/i)) {
      if (a.clause === b.clause || !partyCompatible([a], [b])) continue;
      findings.push(
        pair(
          a,
          b,
          `Clause ${a.clause} grants a right that cannot be withdrawn, while clause ${b.clause} allows termination of the same arrangement.`,
        ),
      );
    }
  }

  // 2. Arbitration against exclusive court jurisdiction.
  for (const a of matchAny(ev, /arbitrat/i)) {
    for (const b of matchAny(ev, /exclusive jurisdiction|courts? (?:at|of|in) [A-Za-z]|sole jurisdiction/i)) {
      if (a.clause === b.clause || !partyCompatible([a], [b])) continue;
      findings.push(pair(a, b, `Clause ${a.clause} sends disputes to arbitration, while clause ${b.clause} gives exclusive court jurisdiction.`));
    }
  }

  // 3. Two different guarantees or deposits for one purpose.
  const deposits = matchAny(ev, /(security )?deposit|guarantee/i);
  for (let i = 0; i < deposits.length; i++) {
    for (let j = i + 1; j < deposits.length; j++) {
      const a = deposits[i];
      const b = deposits[j];
      if (a.clause === b.clause || !partyCompatible([a], [b])) continue;
      findings.push(
        pair(a, b, `Clause ${a.clause} and clause ${b.clause} each create a deposit or guarantee for the same purpose with different terms.`),
      );
    }
  }

  // 4. Two figures in one clause for the same subject. Different subjects (a fee and a deposit)
  // and different kinds (money and a rate) are not a conflict.
  const FIGURE = /(?:rs\.?|inr|₹)\s?[\d,]+(?:\.[\d]+)?|[\d,]+\s?(?:per cent|%)/gi;
  for (const c of clauses) {
    const figures = c.obligations.flatMap((o) =>
      [...o.quote.matchAll(FIGURE)].map((m) => ({
        amount: m[0],
        subject: subjectBefore(o.quote, m.index ?? 0),
        kind: /%|per cent/i.test(m[0]) ? ('rate' as const) : ('money' as const),
        clause: c.clauseNo,
        itemId: o.itemId,
      })),
    );
    for (let i = 0; i < figures.length; i++) {
      for (let j = i + 1; j < figures.length; j++) {
        const a = figures[i];
        const b = figures[j];
        if (!a.subject || a.subject !== b.subject || a.kind !== b.kind) continue;
        if (a.amount.replace(/\s/g, '') === b.amount.replace(/\s/g, '')) continue;
        findings.push({
          kind: 'contradiction',
          text: `Clause ${c.clauseNo} gives two different figures (${a.amount} and ${b.amount}) for ${a.subject}.`,
          itemIds: [a.itemId, b.itemId],
          severity: 'medium',
          reason: 'The same subject is given two different figures in one clause.',
        });
      }
    }
  }

  // 5. Two different notice periods for the same right (termination). Escalation, review and
  // interest intervals are not notice periods and never pair with one.
  const isTerminationNotice = (q: string) =>
    /terminat/i.test(q) && /notice/i.test(q) && !/escalat|increas|review|every|interest|penalt|late|renewal/i.test(q);
  const periods = ev
    .filter((e) => isTerminationNotice(e.quote))
    .map((e) => ({ ...e, span: /(\d{1,3})\s*(days?|weeks?|months?)/i.exec(e.quote) }))
    .filter((e) => e.span);
  for (let i = 0; i < periods.length; i++) {
    for (let j = i + 1; j < periods.length; j++) {
      const a = periods[i];
      const b = periods[j];
      if (a.clause === b.clause || a.span![0].toLowerCase() === b.span![0].toLowerCase()) continue;
      if (!partyCompatible([a], [b])) continue;
      findings.push({
        kind: 'contradiction',
        text: `Clause ${a.clause} and clause ${b.clause} state different termination notice periods (${a.span![0]} and ${b.span![0]}).`,
        itemIds: [a.itemId, b.itemId],
        severity: 'medium',
        reason: 'The same termination right is given two different notice periods.',
      });
    }
  }

  return findings;
}
