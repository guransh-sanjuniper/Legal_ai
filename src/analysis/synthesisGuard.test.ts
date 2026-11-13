import { describe, it, expect } from 'vitest';
import { NOT_CLEAR_ANSWER, finalizeSynthesis, prepareSynthesis } from './promptPass';
import type { PromptAnswer } from './types';

// Scripted model: the sentences a model would write from the verified answers. The guard code is
// the real synthesis code; only the model's reply is fixed.
const answer = (id: string, quote: string, clause: string, page: number, why: string): PromptAnswer => ({
  itemId: id,
  text: quote,
  clause,
  page,
  quote,
  verified: true,
  part: 'answer',
  why,
});

// The termination question, answered from a payment-default notice. Reproduced failure 2.
const TERMINATION_Q = 'What is the notice period for termination?';
const defaultCure = answer(
  'P1',
  'The Licensee shall cure any payment default within ten days after written notice of default.',
  '12',
  9,
  'Gives a ten-day cure period after a default notice.',
);

// The deposit question, answered from a hardship rate table. Reproduced failure 1.
const DEPOSIT_Q = 'What is the security deposit amount?';
const hardshipRate = answer(
  'P1',
  'Hardship compensation is payable at Rs. 70.00 per day of delay under Schedule B.',
  'Schedule B',
  14,
  'Gives the daily hardship compensation rate.',
);

// A real deposit clause with an amount. Must still be answered.
const depositClause = answer(
  'P1',
  'The Licensee shall pay a security deposit of Rs. 50,000 on signing.',
  '4',
  3,
  'States the security deposit amount.',
);

describe('reproduced failures are rejected, not answered', () => {
  it('termination notice from a payment-default clause: no answer, "not clearly stated"', () => {
    const { relevant, dropped } = prepareSynthesis([defaultCure], TERMINATION_Q);
    expect(relevant).toEqual([]);
    expect(dropped).toBe(1);
    // Even if the model writes the wrong figure and cites the quote, it never reaches the reader.
    const scripted = [{ text: 'The notice period for termination is 15 days.', cites: ['P1'] }];
    const out = finalizeSynthesis(relevant, scripted, false);
    expect(out.answer).toEqual([{ text: NOT_CLEAR_ANSWER, cites: [] }]);
  });

  it('security deposit from a rate table: no figure, "not clearly stated"', () => {
    const { relevant } = prepareSynthesis([hardshipRate], DEPOSIT_Q);
    expect(relevant).toEqual([]);
    const scripted = [{ text: 'The security deposit amount is 70.00.', cites: ['P1'] }];
    const out = finalizeSynthesis(relevant, scripted, false);
    expect(out.answer).toEqual([{ text: NOT_CLEAR_ANSWER, cites: [] }]);
    expect(JSON.stringify(out.answer)).not.toContain('70.00');
  });

  it('a wrong answer among right ones is removed, and the right one is kept', () => {
    const { relevant, dropped } = prepareSynthesis([hardshipRate, depositClause], DEPOSIT_Q);
    expect(relevant.map((a) => a.itemId)).toEqual(['P1']);
    expect(relevant[0].quote).toContain('security deposit');
    expect(dropped).toBe(1);
  });
});

describe('a correct answer is still answered', () => {
  it('keeps the deposit clause and repeats its currency', () => {
    const { relevant } = prepareSynthesis([depositClause], DEPOSIT_Q);
    const scripted = [{ text: 'The security deposit is Rs. 50,000 on signing.', cites: ['P1'] }];
    const out = finalizeSynthesis(relevant, scripted, false);
    expect(out.answer).toEqual([{ text: 'The security deposit is Rs. 50,000 on signing.', cites: ['P1'] }]);
    expect(out.numericDropped).toBe(0);
  });

  it('drops a sentence whose figure has no currency, even when the clause is right', () => {
    const { relevant } = prepareSynthesis([depositClause], DEPOSIT_Q);
    const scripted = [{ text: 'The security deposit is 50,000.', cites: ['P1'] }];
    const out = finalizeSynthesis(relevant, scripted, false);
    expect(out.answer).toEqual([{ text: NOT_CLEAR_ANSWER, cites: [] }]);
    expect(out.numericDropped).toBe(1);
  });
});

describe('finalizeSynthesis when the call failed', () => {
  it('leaves the answer empty so the caller reports the error, rather than claiming "not clearly stated"', () => {
    const out = finalizeSynthesis([depositClause], [], true);
    expect(out.answer).toEqual([]);
  });
});
