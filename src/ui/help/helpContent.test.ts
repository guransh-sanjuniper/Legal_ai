import { describe, expect, it } from 'vitest';
import { HELP_INTRO, HELP_SECTIONS, helpSection, pickWhenToUse } from './helpContent';
import { HELP_ITEM, WORKSPACE_ITEMS } from '../app/navItems';

describe('help content', () => {
  it('has a non-empty intro', () => {
    expect(HELP_INTRO.trim().length).toBeGreaterThan(0);
  });

  it('gives every section an id, title, when-to-use line and steps', () => {
    for (const section of HELP_SECTIONS) {
      expect(section.id.trim().length).toBeGreaterThan(0);
      expect(section.title.trim().length).toBeGreaterThan(0);
      expect(section.whenToUse.trim().length).toBeGreaterThan(0);
      expect(section.steps.length).toBeGreaterThan(0);
      expect(typeof section.tip).toBe('string');
    }
  });

  it('uses unique anchors and the four module anchors', () => {
    const ids = HELP_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['documents', 'deep-analysis', 'chat', 'drafter']);
  });

  it('looks a section up by id', () => {
    for (const section of HELP_SECTIONS) {
      expect(helpSection(section.id)).toBe(section);
    }
  });

  it('picks the shorter of the existing description and the help wording', () => {
    expect(pickWhenToUse(undefined, 'chat')).toBe(helpSection('chat').whenToUse);
    expect(pickWhenToUse('Short line.', 'chat')).toBe('Short line.');
    expect(pickWhenToUse('x'.repeat(1000), 'chat')).toBe(helpSection('chat').whenToUse);
  });
});

describe('sidebar items', () => {
  it('does not list Comparator', () => {
    const labels = [...WORKSPACE_ITEMS, HELP_ITEM].map((item) => item.label);
    expect(labels).not.toContain('Comparator');
  });

  it('lists Help below the module entries', () => {
    expect(HELP_ITEM).toEqual({ to: '/help', label: 'Help', icon: 'help' });
    expect([...WORKSPACE_ITEMS, HELP_ITEM].at(-1)).toBe(HELP_ITEM);
  });
});
