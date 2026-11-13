export interface PaymentRef {
  itemId: string;
  clause: string;
  amount: string;
  payer: string;
  payee: string;
  due: string;
  page: number;
}

export interface CrossFinding {
  kind: 'contradiction' | 'gap' | 'payment_total';
  text: string;
  itemIds: string[];
  severity: 'high' | 'medium' | 'low';
  // One line explaining why the two items conflict.
  reason?: string;
}

export interface PaymentTotal {
  payer: string;
  payee: string;
  count: number;
  amounts: string[];
  numericTotal: number | null;
}

const CURRENCY = /(rs\.?|₹|inr|rupees|\/-)/i;

export function parseAmount(raw: string): number | null {
  if (!CURRENCY.test(raw)) return null;
  const cleaned = raw.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!cleaned) return null;
  return Number(cleaned[0]);
}

export function paymentTotals(payments: PaymentRef[]): PaymentTotal[] {
  const map = new Map<string, PaymentTotal>();
  for (const p of payments) {
    const key = `${p.payer.trim().toLowerCase()}→${p.payee.trim().toLowerCase()}`;
    const row = map.get(key) ?? { payer: p.payer, payee: p.payee, count: 0, amounts: [], numericTotal: 0 };
    row.count++;
    row.amounts.push(p.amount);
    const n = parseAmount(p.amount);
    if (n === null) row.numericTotal = null;
    else if (row.numericTotal !== null) row.numericTotal += n;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function findContradictions(clauses: {
  clause: string;
  itemId: string;
  dates: { text: string; timing_type: string; itemId: string }[];
  payments: { due: string; amount: string; itemId: string }[];
}[]): CrossFinding[] {
  const findings: CrossFinding[] = [];

  const byDate = new Map<string, { timing: string; itemIds: string[]; clauses: string[] }>();
  for (const c of clauses) {
    for (const d of c.dates) {
      const key = d.text.trim().toLowerCase();
      if (!key) continue;
      const prev = byDate.get(key);
      if (!prev) byDate.set(key, { timing: d.timing_type, itemIds: [d.itemId], clauses: [c.clause] });
      else if (prev.timing !== d.timing_type) {
        prev.itemIds.push(d.itemId);
        prev.clauses.push(c.clause);
        findings.push({
          kind: 'contradiction',
          text: `The same date "${d.text}" is classified as ${prev.timing} and ${d.timing_type} (clauses ${prev.clauses.join(', ')}).`,
          itemIds: [...prev.itemIds],
          severity: 'medium',
        });
      } else {
        prev.itemIds.push(d.itemId);
      }
    }
  }

  const byDue = new Map<string, { amount: string; itemIds: string[]; clauses: string[] }>();
  for (const c of clauses) {
    for (const p of c.payments) {
      const key = p.due.trim().toLowerCase();
      if (!key) continue;
      const prev = byDue.get(key);
      if (!prev) byDue.set(key, { amount: p.amount, itemIds: [p.itemId], clauses: [c.clause] });
      else if (prev.amount.trim().toLowerCase() !== p.amount.trim().toLowerCase()) {
        prev.itemIds.push(p.itemId);
        prev.clauses.push(c.clause);
        findings.push({
          kind: 'contradiction',
          text: `Payments due "${p.due}" have different amounts (${prev.amount} and ${p.amount}) in clauses ${prev.clauses.join(', ')}.`,
          itemIds: [...prev.itemIds],
          severity: 'high',
        });
      } else {
        prev.itemIds.push(p.itemId);
      }
    }
  }

  return findings;
}

export const EXPECTED_TOPICS: { label: string; pattern: RegExp }[] = [
  { label: 'possession', pattern: /possession|hand ?over|handover/i },
  { label: 'payment schedule', pattern: /payment|instal?ment|consideration/i },
  { label: 'termination', pattern: /terminat|cancel|rescind/i },
  { label: 'arbitration / dispute resolution', pattern: /arbitrat|dispute|jurisdiction/i },
  { label: 'registration / stamp duty', pattern: /regist|stamp duty/i },
];

// Candidate gaps from structured data only. The caller must run a whole-document search
// before reporting any of these as missing.
export function missingTopicCandidates(clauses: { summary: string; type: string; text?: string }[]): { label: string; pattern: RegExp }[] {
  const haystack = clauses.map((c) => `${c.type} ${c.summary} ${c.text ?? ''}`).join(' ');
  return EXPECTED_TOPICS.filter((t) => !t.pattern.test(haystack));
}
