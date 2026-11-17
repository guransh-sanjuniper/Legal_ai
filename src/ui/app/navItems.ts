export type NavIconName = 'document' | 'analysis' | 'draft' | 'help';

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
