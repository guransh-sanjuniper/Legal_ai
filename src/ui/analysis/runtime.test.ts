import { describe, it, expect } from 'vitest';
import { taskLabel } from './runtime';

describe('task labels', () => {
  it('names the synthesis, summary and statutory passes', () => {
    expect(taskLabel('run:ps')).toBe('Prompt synthesis');
    expect(taskLabel('run:es')).toBe('Executive summary');
    expect(taskLabel('run:ovf')).toBe('Termination and dispute points');
    expect(taskLabel('run:laws')).toBe('Statutory laws');
    expect(taskLabel('run:m0')).toBe('Missing protections');
    expect(taskLabel('run:a3')).toBe('Clause analysis');
  });
});
