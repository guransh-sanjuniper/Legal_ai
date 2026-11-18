import { describe, expect, it } from 'vitest';
import {
  LEAVE_BEHAVIOUR,
  leaveMessage,
  shouldBlockNav,
  type LeaveBehaviour,
  type LeaveJob,
} from './leaveGuard';

const ORIGIN = 'https://app.example';

function nav(over: Partial<Parameters<typeof shouldBlockNav>[0]> = {}) {
  return shouldBlockNav({
    active: true,
    href: `${ORIGIN}/analysis/doc-1`,
    currentHref: `${ORIGIN}/documents`,
    ...over,
  });
}

describe('leaveMessage', () => {
  it('uses the stop wording for a job that does not survive a page change', () => {
    expect(LEAVE_BEHAVIOUR.analysis).toBe('stops');
    const text = leaveMessage('analysis');
    expect(text).toContain('will stop or may fail');
    expect(text).not.toContain('keeps going');
  });

  it('uses continue wording for preparing a document', () => {
    expect(LEAVE_BEHAVIOUR.preparation).toBe('continues');
    const text = leaveMessage('preparation');
    expect(text).toContain('Your document is still being prepared');
    expect(text).toContain('keeps going if you open another page');
    expect(text).not.toContain('will stop or may fail');
  });

  it('uses continue wording for writing a draft', () => {
    expect(LEAVE_BEHAVIOUR.drafter).toBe('continues');
    const text = leaveMessage('drafter');
    expect(text).toContain('Your draft is still being written');
    expect(text).toContain('stops if you close or reload this tab');
    expect(text).not.toContain('will stop or may fail');
  });

  it('selects by an explicit behaviour too', () => {
    const cases: [LeaveJob, LeaveBehaviour, string][] = [
      ['drafter', 'continues', 'keeps going'],
      ['preparation', 'stops', 'will stop or may fail'],
    ];
    for (const [job, behaviour, expected] of cases) {
      expect(leaveMessage(job, behaviour)).toContain(expected);
    }
  });
});

describe('shouldBlockNav', () => {
  it('does nothing while the guard is inactive', () => {
    expect(nav({ active: false })).toBe(false);
  });

  it('blocks an in-app path change while active', () => {
    expect(nav()).toBe(true);
    expect(nav({ href: `${ORIGIN}/analysis/doc-1?tab=risks` })).toBe(true);
    expect(nav({ currentHref: `${ORIGIN}/documents?page=2`, href: `${ORIGIN}/documents` })).toBe(true);
  });

  it('allows same-page hash moves while active', () => {
    expect(nav({ href: `${ORIGIN}/documents#help` })).toBe(false);
    expect(nav({ href: '#help' })).toBe(false);
  });

  it('allows external, new-tab, download and modifier navigation', () => {
    expect(nav({ href: 'https://other.example/documents' })).toBe(false);
    expect(nav({ target: '_blank' })).toBe(false);
    expect(nav({ download: true })).toBe(false);
    expect(nav({ modifier: true })).toBe(false);
  });

  it('fails open when the address cannot be parsed', () => {
    expect(nav({ currentHref: 'not a url' })).toBe(false);
  });
});
