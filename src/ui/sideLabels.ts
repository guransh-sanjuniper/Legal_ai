import type { ReviewingFor } from '../analysis/types';

// The wording shown in the "reviewing for / which side" dropdowns, shared by the
// Deep Analysis start form and the Drafter Brief so both screens read the same.
// This is display text only: the stored value stays exactly
// 'licensor' | 'licensee' | 'neutral' and nothing else reads the label.
export interface SideOption {
  value: ReviewingFor;
  label: string;
}

export const SIDE_OPTIONS: readonly SideOption[] = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'licensor', label: 'Licensor (landlord, lessor, owner, seller)' },
  { value: 'licensee', label: 'Licensee (tenant, lessee, occupant, buyer)' },
];
