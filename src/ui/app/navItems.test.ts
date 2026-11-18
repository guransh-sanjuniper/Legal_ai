import { describe, expect, it } from 'vitest';
import {
  HELP_ITEM,
  WORKSPACE_ITEMS,
  comparatorItem,
  comparatorUrl,
  isComparatorItem,
  sidebarEntries,
} from './navItems';

const URL_VALUE = 'https://compare.example.com';

describe('comparator URL', () => {
  it('is hidden when the variable is unset or blank', () => {
    expect(comparatorUrl(undefined)).toBeNull();
    expect(comparatorUrl(null)).toBeNull();
    expect(comparatorUrl('')).toBeNull();
    expect(comparatorUrl('   ')).toBeNull();
    expect(comparatorItem(undefined)).toBeNull();
    expect(comparatorItem('')).toBeNull();
  });

  it('accepts only an absolute https address', () => {
    expect(comparatorUrl(URL_VALUE)).toBe('https://compare.example.com/');
    expect(comparatorUrl('https://compare.example.com')).toMatch(/^https:\/\//);
    expect(comparatorUrl(`  ${URL_VALUE}/app?x=1  `)).toBe('https://compare.example.com/app?x=1');
  });

  it('rejects every other scheme and malformed value', () => {
    for (const raw of [
      'http://compare.example.com',
      'javascript:alert(1)',
      'data:text/html,x',
      '//compare.example.com',
      '/compare',
      'compare.example.com',
      'not a url',
    ]) {
      expect(comparatorUrl(raw)).toBeNull();
    }
  });

  it('builds the sidebar item from a valid address only', () => {
    expect(comparatorItem(URL_VALUE)).toEqual({
      label: 'Comparator',
      icon: 'compare',
      url: 'https://compare.example.com/',
    });
  });
});

describe('sidebar entries', () => {
  it('keeps today’s list when the Comparator address is unset', () => {
    const labels = sidebarEntries({ comparator: comparatorItem(undefined) }).map((item) => item.label);
    expect(labels).toEqual(['Documents', 'Deep Analysis', 'Drafter', 'Help']);
  });

  it('puts Comparator after Drafter and before Help when the address is set', () => {
    const entries = sidebarEntries({ comparator: comparatorItem(URL_VALUE) });
    expect(entries.map((item) => item.label)).toEqual([
      'Documents',
      'Deep Analysis',
      'Drafter',
      'Comparator',
      'Help',
    ]);
    expect(entries.findIndex(isComparatorItem)).toBe(3);
    expect(entries.filter(isComparatorItem)).toHaveLength(1);
    expect(entries.at(-1)).toBe(HELP_ITEM);
    expect(entries.at(-2)).toEqual(comparatorItem(URL_VALUE));
  });

  it('passes route items through unchanged, so hrefs and highlighting cannot drift', () => {
    for (const comparator of [null, comparatorItem(URL_VALUE)]) {
      const routeItems = sidebarEntries({ comparator }).filter((item) => !isComparatorItem(item));
      expect(routeItems).toEqual([...WORKSPACE_ITEMS, HELP_ITEM]);
      routeItems.forEach((item, index) => {
        expect(item).toBe([...WORKSPACE_ITEMS, HELP_ITEM][index]);
      });
    }
  });

  it('never marks the Comparator entry as a route link', () => {
    const entries = sidebarEntries({ comparator: comparatorItem(URL_VALUE) });
    for (const item of entries) {
      if (isComparatorItem(item)) {
        expect(item).not.toHaveProperty('to');
      } else {
        expect(item.to.startsWith('/')).toBe(true);
      }
    }
  });
});
