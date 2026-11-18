import { describe, expect, it } from 'vitest';
import { HELP_SECTIONS } from './helpContent';
import { DRAFTS_LIST_PAGE_ID, PAGE_HELP, PAGE_HELP_IDS } from './pageHelp';

const EXPECTED_IDS = [
  'documents',
  'analysis-list',
  'analysis-report',
  'chat',
  'drafter-brief',
  'drafter-plan',
  'drafter-outline',
  'drafter-sources',
  'drafter-write',
  'drafter-review',
];

describe('page help', () => {
  it('has exactly the expected page ids, with no duplicates', () => {
    expect([...PAGE_HELP_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
    expect(new Set(PAGE_HELP_IDS).size).toBe(PAGE_HELP_IDS.length);
    expect(Object.keys(PAGE_HELP).length).toBe(EXPECTED_IDS.length);
  });

  it('gives every page a title, an anchor and 3 to 5 non-empty steps', () => {
    const anchors = HELP_SECTIONS.map((section) => section.id);
    for (const id of PAGE_HELP_IDS) {
      const help = PAGE_HELP[id];
      expect(help.title.trim().length).toBeGreaterThan(0);
      expect(anchors).toContain(help.helpAnchor);
      expect(help.steps.length).toBeGreaterThanOrEqual(3);
      expect(help.steps.length).toBeLessThanOrEqual(5);
      for (const step of help.steps) {
        expect(step.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('points the drafts list at the Brief text', () => {
    expect(PAGE_HELP[DRAFTS_LIST_PAGE_ID]).toBe(PAGE_HELP['drafter-brief']);
  });
});
