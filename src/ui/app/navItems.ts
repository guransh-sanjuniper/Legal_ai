export type NavIconName = 'document' | 'analysis' | 'draft' | 'compare' | 'help';

export interface NavItem {
  to: string;
  label: string;
  icon: NavIconName;
}

export const WORKSPACE_ITEMS: readonly NavItem[] = [
  { to: '/documents', label: 'Documents', icon: 'document' },
  { to: '/analysis', label: 'Deep Analysis', icon: 'analysis' },
  { to: '/draft', label: 'Drafter', icon: 'draft' },
];

export const HELP_ITEM: NavItem = { to: '/help', label: 'Help', icon: 'help' };

// ---------------------------------------------------------------------------
// Comparator: a separate app opened in a new tab, not a route of this app.
// Its address comes from VITE_COMPARATOR_URL. When the variable is unset or is
// not an https address the sidebar entry is hidden, so a missing or mistyped
// value can never render a broken link.
// ---------------------------------------------------------------------------

export const COMPARATOR_LABEL = 'Comparator';

export interface ComparatorItem {
  label: typeof COMPARATOR_LABEL;
  icon: 'compare';
  url: string;
}

export type SidebarEntry = NavItem | ComparatorItem;

// Only an absolute https address is accepted. Anything unparsable, relative,
// protocol-relative or using another scheme (http, javascript, data) is null.
export function comparatorUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.toString();
}

export function comparatorItem(raw: string | null | undefined): ComparatorItem | null {
  const url = comparatorUrl(raw);
  return url ? { label: COMPARATOR_LABEL, icon: 'compare', url } : null;
}

export function isComparatorItem(entry: SidebarEntry): entry is ComparatorItem {
  return 'url' in entry;
}

// The sidebar order: the workspace modules, then Comparator, then Help.
export function sidebarEntries({ comparator }: { comparator: ComparatorItem | null }): readonly SidebarEntry[] {
  return comparator
    ? [...WORKSPACE_ITEMS, comparator, HELP_ITEM]
    : [...WORKSPACE_ITEMS, HELP_ITEM];
}
