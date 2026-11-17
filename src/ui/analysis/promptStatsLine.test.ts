import { describe, it, expect } from 'vitest';
import { promptStatsLine } from './ReportView';

// The small coverage line under the on-screen Prompt Result answer.
describe('prompt stats line', () => {
  it('gives the passage count and the page range', () => {
    expect(promptStatsLine({ cited: 14, pageStart: 3, pageEnd: 41, excluded: 0, readSections: null, moreSections: null })).toBe(
      'Based on 14 passages from pages 3–41.',
    );
    expect(promptStatsLine({ cited: 1, pageStart: 7, pageEnd: 7, excluded: 0, readSections: null, moreSections: null })).toBe(
      'Based on 1 passage from page 7.',
    );
  });

  it('says how many quotes the guards left out and how much was read for coverage', () => {
    expect(promptStatsLine({ cited: 3, pageStart: 2, pageEnd: 9, excluded: 2, readSections: 10, moreSections: 4 })).toBe(
      'Based on 3 passages from pages 2–9. 2 quotes were not relevant to the request and are not used. 10 extra sections read for coverage; 4 matching sections not read.',
    );
  });
});
