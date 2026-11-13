import { describe, it, expect } from 'vitest';
import { NOT_CLEAR_ANSWER, checkRelevance, finalizeSynthesis, prepareSynthesis } from './promptPass';
import type { PromptAnswer } from './types';

// A scripted relevance judge: every quote it is sent gets the same verdict.
const judgeAll = (verdict: 'yes' | 'no', seen: string[][] = []) => async (batches: PromptAnswer[][]) => {
  for (const b of batches) seen.push(b.map((a) => a.itemId));
  return batches.flat().map((a) => ({ id: a.itemId, verdict, reason: `scripted ${verdict}` }));
};

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

// The reported case: clause 19(g) states a refundable deposit, and says "deposit", not "security
// deposit". A synonym must not make a correct answer look like a wrong one.
describe('a synonym is not a mismatch', () => {
  const DEPOSIT_REFUND_Q = 'What is the security deposit amount and is it refundable?';
  const refundableDeposit = answer(
    'P1',
    "The Licensee pays a refundable deposit of one or three months' rent, returned at the end of the licence.",
    '19(g)',
    7,
    'States the deposit amount and that it is refundable.',
  );

  it('keeps a quote that says deposit for a security deposit question', () => {
    const { relevant, dropped } = prepareSynthesis([refundableDeposit], DEPOSIT_REFUND_Q);
    expect(relevant.map((a) => a.itemId)).toEqual(['P1']);
    expect(dropped).toBe(0);
  });

  it('shows the answer from that kept quote, not "not clearly stated"', () => {
    const { relevant } = prepareSynthesis([refundableDeposit], DEPOSIT_REFUND_Q);
    const scripted = [{ text: "The deposit is refundable and is one or three months' rent.", cites: ['P1'] }];
    const out = finalizeSynthesis(relevant, scripted, false);
    expect(out.answer).toEqual([{ text: "The deposit is refundable and is one or three months' rent.", cites: ['P1'] }]);
  });

  it('still rejects the wrong clause for the same question (no deposit, no refund)', () => {
    const { relevant } = prepareSynthesis([defaultCure], DEPOSIT_REFUND_Q);
    expect(relevant).toEqual([]);
  });
});

describe('finalizeSynthesis when the call failed', () => {
  it('leaves the answer empty so the caller reports the error, rather than claiming "not clearly stated"', () => {
    const out = finalizeSynthesis([depositClause], [], true);
    expect(out.answer).toEqual([]);
  });
});

// The second chance: a quote the subject check rejects is judged by the model in one batch. A "no"
// keeps it rejected, so the three regression cases above still end in "not clearly stated".
describe('second-chance relevance check on the regression cases', () => {
  it('termination from a payment-default clause: sent to the check, judged no, still rejected', async () => {
    const seen: string[][] = [];
    const out = await checkRelevance({ answers: [defaultCure], request: TERMINATION_Q, ask: judgeAll('no', seen) });
    expect(seen).toEqual([['P1']]);
    expect(out.relevant).toEqual([]);
    expect(out.relevance).toMatchObject({ checked: 1, kept: 0, rejected: 1, calls: 1 });
    const finalized = finalizeSynthesis(out.relevant, [{ text: 'The notice period for termination is 15 days.', cites: ['P1'] }], false);
    expect(finalized.answer).toEqual([{ text: NOT_CLEAR_ANSWER, cites: [] }]);
  });

  it('security deposit from a rate table: sent to the check, judged no, still rejected', async () => {
    const seen: string[][] = [];
    const out = await checkRelevance({ answers: [hardshipRate], request: DEPOSIT_Q, ask: judgeAll('no', seen) });
    expect(seen).toEqual([['P1']]);
    expect(out.relevant).toEqual([]);
    const finalized = finalizeSynthesis(out.relevant, [{ text: 'The security deposit amount is 70.00.', cites: ['P1'] }], false);
    expect(finalized.answer).toEqual([{ text: NOT_CLEAR_ANSWER, cites: [] }]);
    expect(JSON.stringify(finalized.answer)).not.toContain('70.00');
  });

  it('a wrong answer among right ones: only the wrong one is judged, and it stays out', async () => {
    const right = { ...depositClause, itemId: 'P2' };
    const seen: string[][] = [];
    const out = await checkRelevance({ answers: [hardshipRate, right], request: DEPOSIT_Q, ask: judgeAll('no', seen) });
    expect(seen).toEqual([['P1']]);
    expect(out.relevant).toEqual([right]);
    expect(out.dropped).toBe(1);
    expect(out.relevance).toMatchObject({ checked: 1, kept: 0 });
  });

  it('a quote that passes the subject check is never sent to the model', async () => {
    let calls = 0;
    const out = await checkRelevance({
      answers: [depositClause],
      request: DEPOSIT_Q,
      ask: async () => { calls++; return []; },
    });
    expect(calls).toBe(0);
    expect(out.relevant).toEqual([depositClause]);
    expect(out.relevance.calls).toBe(0);
  });
});

describe('second-chance relevance check keeps a correct answer phrased differently', () => {
  // "Handover" is not in the synonym map, so the subject check rejects a correct answer.
  const HANDOVER_Q = 'When is the handover date?';
  const possession = answer(
    'P1',
    'Possession shall be given to the Licensee on 1 May 2026.',
    '5',
    4,
    'Gives the date the Licensee takes possession.',
  );

  it('the subject check alone rejects it', () => {
    expect(prepareSynthesis([possession], HANDOVER_Q).relevant).toEqual([]);
  });

  it('the model check says yes: the quote is kept, with the model reason as its why', async () => {
    const out = await checkRelevance({
      answers: [{ ...possession, why: undefined }],
      request: HANDOVER_Q,
      ask: judgeAll('yes'),
    });
    expect(out.relevant.map((a) => a.itemId)).toEqual(['P1']);
    expect(out.relevant[0].why).toBe('scripted yes');
    expect(out.relevance).toMatchObject({ checked: 1, kept: 1, rejected: 0, calls: 1 });
  });

  it('the kept quote reaches the synthesis input and its figures are checked as usual', async () => {
    const out = await checkRelevance({ answers: [possession], request: HANDOVER_Q, ask: judgeAll('yes') });
    const finalized = finalizeSynthesis(out.relevant, [{ text: 'Possession is given on 1 May 2026.', cites: ['P1'] }], false);
    expect(finalized.answer).toEqual([{ text: 'Possession is given on 1 May 2026.', cites: ['P1'] }]);
  });
});
