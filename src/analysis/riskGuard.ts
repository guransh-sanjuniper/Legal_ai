// Guards applied after the model has spoken. They never invent content: they keep a risk the
// validation pass was too eager to drop, and they infer which party a term affects.

const COST_TERM = /stamp duty|registration|tax|cess|charges?|fees?|costs?|indemn|insurance|repairs?|penalt/i;
const BEARING_VERB = /\b(bear|bears|borne|pay|pays|paid|liable|indemnif\w*|forfeit\w*)\b/i;
// Generic roles that name a party without relying on a specific document.
const ROLE = /\b(licensor|licensee|lessor|lessee|landlord|tenant|vendor|purchaser|owner|developer|allottee|buyer|seller|supplier|contractor|employer|employee|borrower|lender|guarantor)\b/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A term that puts a cost or liability on a named party can be downgraded, never dropped.
// Both a cost keyword and a bearing verb must be present, and a party must be named either in
// the document's party list or by a generic role. Boilerplate that merely mentions fees is not
// protected and may still be dropped.
export function protectsFromDrop(
  item: { issue: string; quote: string },
  partyNames: string[] = [],
): boolean {
  const text = `${item.issue} ${item.quote}`;
  if (!COST_TERM.test(text) || !BEARING_VERB.test(text)) return false;
  if (partyNames.some((n) => n.trim() && new RegExp(escapeRe(n.trim()), 'i').test(text))) return true;
  return ROLE.test(text);
}

const CLAUSE_PARTIES = /\b(licensor|licensee|lessor|lessee|landlord|tenant|vendor|purchaser|owner|developer|allottee|buyer|seller|supplier|contractor|employer|employee|borrower|lender|guarantor)\b/gi;

// Which party a risk affects: a party named in the risk text, then the roles in its own text,
// then the parties on the clause. "Both/unclear" when the text does not say.
export function inferAffects(opts: {
  issue: string;
  quote: string;
  clauseParties: string[];
  partyNames?: string[];
}): string {
  const text = `${opts.issue} ${opts.quote}`;
  const known = (opts.partyNames ?? []).filter((n) => n.trim() && new RegExp(escapeRe(n.trim()), 'i').test(text));
  if (known.length === 1) return known[0];
  if (known.length > 1) return 'Both/unclear';
  const roles = [...new Set((text.match(CLAUSE_PARTIES) ?? []).map((r) => r.toLowerCase()))];
  if (roles.length === 1) return roles[0].replace(/^./, (c) => c.toUpperCase());
  if (roles.length > 1) return 'Both/unclear';
  const clause = [...new Set(opts.clauseParties.filter(Boolean))];
  if (clause.length === 1) return clause[0];
  return 'Both/unclear';
}
