import { describe, expect, it } from 'vitest';
import { decideBriefContinue } from './briefContinue';

const base = {
  instructionTrimmed: 'Draft a lease.',
  draftExists: true,
  dirty: false,
  planFreshForForm: true,
};

describe('Brief Continue decision', () => {
  it('blocks an empty instruction', () => {
    expect(decideBriefContinue({ ...base, instructionTrimmed: '   ' })).toBe('blocked:instruction');
    expect(decideBriefContinue({ ...base, instructionTrimmed: '', draftExists: false })).toBe(
      'blocked:instruction',
    );
  });

  it('creates a new draft and reads it', () => {
    expect(decideBriefContinue({ ...base, draftExists: false, planFreshForForm: false })).toBe(
      'create-and-read',
    );
  });

  it('navigates without a model call when the draft is unchanged and the plan is fresh', () => {
    expect(decideBriefContinue(base)).toBe('navigate');
  });

  it('reads an unchanged draft when the plan is missing or stale', () => {
    expect(decideBriefContinue({ ...base, planFreshForForm: false })).toBe('read');
  });

  it('saves and re-reads when the content changed and the plan is stale', () => {
    expect(decideBriefContinue({ ...base, dirty: true, planFreshForForm: false })).toBe(
      'save-and-read',
    );
  });

  it('saves and re-reads when the content changed and no plan exists', () => {
    expect(decideBriefContinue({ ...base, dirty: true, planFreshForForm: false })).toBe(
      'save-and-read',
    );
  });

  it('saves and navigates for a title-only change that leaves the plan fresh', () => {
    expect(decideBriefContinue({ ...base, dirty: true, planFreshForForm: true })).toBe(
      'save-and-navigate',
    );
  });
});
