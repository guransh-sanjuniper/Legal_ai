import { describe, expect, it } from 'vitest';
import { REVIEWING_FOR } from '../analysis/request';
import { SIDE_OPTIONS } from './sideLabels';

describe('side labels', () => {
  it('offers exactly three options, one per stored value', () => {
    expect(SIDE_OPTIONS).toHaveLength(3);
    const values = SIDE_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort()).toEqual([...REVIEWING_FOR].sort());
  });

  it('maps every label to a valid stored value', () => {
    for (const option of SIDE_OPTIONS) {
      expect(REVIEWING_FOR).toContain(option.value);
    }
  });

  it('keeps every stored value present', () => {
    for (const value of REVIEWING_FOR) {
      expect(SIDE_OPTIONS.some((option) => option.value === value)).toBe(true);
    }
  });

  it('uses the approved wording, identical to what both screens show', () => {
    expect(SIDE_OPTIONS).toEqual([
      { value: 'neutral', label: 'Neutral' },
      { value: 'licensor', label: 'Licensor (landlord, lessor, owner, seller)' },
      { value: 'licensee', label: 'Licensee (tenant, lessee, occupant, buyer)' },
    ]);
    const labels = SIDE_OPTIONS.map((option) => option.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
  });

  it('starts each label with its stored value, so the first word never disagrees', () => {
    for (const option of SIDE_OPTIONS) {
      const title = option.value.charAt(0).toUpperCase() + option.value.slice(1);
      expect(option.label.startsWith(title)).toBe(true);
    }
  });

  it('names the ordinary words for each side', () => {
    for (const word of ['landlord', 'lessor', 'owner', 'seller']) {
      expect(SIDE_OPTIONS.find((option) => option.value === 'licensor')!.label).toContain(word);
    }
    for (const word of ['tenant', 'lessee', 'occupant', 'buyer']) {
      expect(SIDE_OPTIONS.find((option) => option.value === 'licensee')!.label).toContain(word);
    }
  });
});
