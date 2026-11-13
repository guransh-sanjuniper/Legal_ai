import type { ClauseProse, RiskBasis } from './types';

export const RISK_PRIORITIES = ['high', 'medium', 'low'] as const;
export type RiskPriority = (typeof RISK_PRIORITIES)[number];

export const RISK_BASES: RiskBasis[] = [
  'void_or_unenforceable',
  'illegal',
  'statutory_violation',
  'major_financial_exposure',
  'other',
];

// High is reserved for these categories. Any other basis is capped at Medium.
const HIGH_BASES = new Set<RiskBasis>(RISK_BASES.filter((b) => b !== 'other'));

export function riskBasisOf(x: unknown): RiskBasis {
  return RISK_BASES.includes(x as RiskBasis) ? (x as RiskBasis) : 'other';
}

export function guardPriority(priority: unknown, basis: unknown): RiskPriority {
  const p: RiskPriority = RISK_PRIORITIES.includes(priority as RiskPriority) ? (priority as RiskPriority) : 'medium';
  if (p === 'high' && !HIGH_BASES.has(riskBasisOf(basis))) return 'medium';
  return p;
}

// Shown when the model gave no suggestion, so the gap is visible rather than hidden.
export const NO_SUGGESTION = 'No suggestion was generated. The lawyer should decide the next step.';

// Same Act with or without a year is one law: lower-case, no years, no punctuation.
export function lawKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(1[89]|20)\d{2}\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normaliseLaws(x: unknown, max = 8): string[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of x) {
    if (typeof v !== 'string') continue;
    const name = v.replace(/\s+/g, ' ').trim();
    const key = lawKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

export function normaliseMissing(x: unknown, max = 12): string[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of x) {
    if (typeof v !== 'string') continue;
    const text = v.replace(/\s+/g, ' ').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export const PROSE_KEYS: (keyof ClauseProse)[] = [
  'detailed_summary',
  'conditions',
  'exceptions',
  'rights',
  'legal_significance',
  'ambiguity',
  'suggested_action',
  'location_mismatch',
];

export function normaliseProse(x: unknown): ClauseProse {
  const o = typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {};
  const out = {} as ClauseProse;
  for (const key of PROSE_KEYS) {
    const v = o[key];
    out[key] = typeof v === 'string' ? v.trim() : '';
  }
  return out;
}

const ORDER: Record<RiskPriority, number> = { high: 0, medium: 1, low: 2 };

// Stable sort: High first, then Medium, then Low. Input order is kept within a priority.
export function sortByPriorityOf<T>(items: T[], priorityOf: (item: T) => RiskPriority): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => ORDER[priorityOf(a.item)] - ORDER[priorityOf(b.item)] || a.i - b.i)
    .map((x) => x.item);
}

export function sortByPriority<T extends { severity: RiskPriority }>(items: T[]): T[] {
  return sortByPriorityOf(items, (item) => item.severity);
}
