import { goldenDocName, type GoldenFile } from '../analysis/goldenScore';

export type SizeBucket = 'small' | 'mid' | 'large';

export interface RegressionEntry {
  label: string;
  bucket: SizeBucket;
  // Base name of the file in tests/golden (without .json).
  goldenFile: string;
  // Expected report.docName. Kept as data so the scorer stays document-neutral.
  document: string | null;
  enabled: boolean;
}

export const BUCKET_LABEL: Record<SizeBucket, string> = {
  small: 'small (under 100 pages)',
  mid: 'mid (100-499 pages)',
  large: 'large (500+ pages)',
};

// The fixed regression set. Add a line per document; the scorer itself never names a document.
// Entries without a golden file are shown as disabled until a planted/lawyer-marked file exists.
export const REGRESSION_SET: RegressionEntry[] = [
  {
    label: 'HIRAMOTI NAGAR CHSL DA (65 pages)',
    bucket: 'mid',
    goldenFile: 'hiramoti',
    document: 'HIRAMOTI NAGAR CHSL DA DRAFT FOR MEMBERS 290626.pdf',
    enabled: true,
  },
  {
    label: 'Planted synthetic (12 pages)',
    bucket: 'small',
    goldenFile: 'planted',
    document: 'planted.pdf',
    enabled: true,
  },
  {
    label: 'Large document (500+ pages)',
    bucket: 'large',
    goldenFile: '',
    document: null,
    enabled: false,
  },
];

export function enabledEntries(entries: RegressionEntry[] = REGRESSION_SET): RegressionEntry[] {
  return entries.filter((e) => e.enabled && e.goldenFile);
}

export function goldenForEntry(
  entry: RegressionEntry,
  goldenFiles: Record<string, GoldenFile>,
): GoldenFile | null {
  return goldenFiles[entry.goldenFile] ?? null;
}

// A saved run belongs to an entry when its document name matches the configured name, or the
// golden file's own document name (older golden files use "document").
export function entryMatchesDocument(
  entry: RegressionEntry,
  docName: string,
  golden: GoldenFile | null,
): boolean {
  if (entry.document && entry.document === docName) return true;
  return golden !== null && goldenDocName(golden) === docName;
}
