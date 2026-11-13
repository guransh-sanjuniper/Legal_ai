import { lawKey } from './rubric';
import type { DocType } from './docType';

// Acts central to a document type, by subject. Small and generic; unknown types get none, so only
// Acts engaged by a clause or a risk appear.
const CENTRAL: Partial<Record<DocType, string[]>> = {
  // Occupancy / licence / lease.
  lease: [
    'Maharashtra Rent Control Act',
    'Transfer of Property Act 1882',
    'Indian Stamp Act 1899',
    'Registration Act 1908',
    'Real Estate (Regulation and Development) Act 2016 (RERA)',
  ],
  // Construction / development / general agreement.
  agreement: ['Indian Contract Act 1872', 'Indian Stamp Act 1899', 'Registration Act 1908', 'Real Estate (Regulation and Development) Act 2016 (RERA)'],
  // Sale / transfer / conveyance.
  deed: ['Transfer of Property Act 1882', 'Registration Act 1908', 'Indian Stamp Act 1899'],
  // Notice / demand.
  notice: ['Transfer of Property Act 1882', 'Indian Contract Act 1872'],
};

export const MAX_STATUTORY_ACTS = 6;

export function centralLawsFor(docType: DocType | null): string[] {
  return docType ? (CENTRAL[docType] ?? []) : [];
}

// Statutory Compliance keeps an Act only when a risk or missing item engages it, or when it is
// central to the document type. Anything else the model proposed is omitted.
export function selectStatutoryLaws(opts: {
  engaged: { name: string; clauses: string[] }[];
  docType: DocType | null;
  proposed: string[];
}): { name: string; clauses: string[] }[] {
  const out: { name: string; clauses: string[] }[] = [];
  const seen = new Set<string>();
  const add = (name: string, clauses: string[]) => {
    const key = lawKey(name);
    if (!key || seen.has(key) || out.length >= MAX_STATUTORY_ACTS) return;
    seen.add(key);
    out.push({ name, clauses });
  };
  for (const law of opts.engaged) add(law.name, law.clauses);
  // A proposed Act is kept only when it is central to the document type.
  const central = centralLawsFor(opts.docType);
  const centralKeys = new Set(central.map(lawKey));
  for (const name of opts.proposed) {
    if (centralKeys.has(lawKey(name))) add(name, []);
  }
  for (const name of central) add(name, []);
  return out;
}
