import { describe, it, expect } from 'vitest';
import { conceptOf, quoteMatchesRequest, requestConcepts } from './questionTerms';

describe('concepts: a synonym names the same thing', () => {
  it('treats security deposit, deposit and security as one concept', () => {
    expect(conceptOf('security')).toBe(conceptOf('deposit'));
    expect(conceptOf('deposit')).toBe(conceptOf('deposits'));
  });

  it('treats lessor and licensor as the landlord, and lessee and licensee as the tenant', () => {
    expect(conceptOf('lessor')).toBe(conceptOf('landlord'));
    expect(conceptOf('licensor')).toBe(conceptOf('landlord'));
    expect(conceptOf('lessee')).toBe(conceptOf('tenant'));
    expect(conceptOf('licensee')).toBe(conceptOf('tenant'));
  });

  it('keeps the landlord and the tenant apart', () => {
    expect(conceptOf('licensor')).not.toBe(conceptOf('licensee'));
    expect(conceptOf('landlord')).not.toBe(conceptOf('tenant'));
  });

  it('treats termination, cancellation and expiry as the ending concept, and refundable as refund', () => {
    expect(conceptOf('terminates')).toBe(conceptOf('termination'));
    expect(conceptOf('cancellation')).toBe(conceptOf('termination'));
    expect(conceptOf('expiry')).toBe(conceptOf('termination'));
    expect(conceptOf('returned')).toBe(conceptOf('refundable'));
    expect(conceptOf('repayment')).toBe(conceptOf('refundable'));
  });

  it('does not treat advance as a deposit (rent is payable in advance)', () => {
    expect(conceptOf('advance')).not.toBe(conceptOf('deposit'));
  });

  it('keeps an unlisted word as its own concept, with plural forms the same', () => {
    expect(conceptOf('payments')).toBe(conceptOf('payment'));
    expect(conceptOf('payment')).not.toBe(conceptOf('deposit'));
  });

  it('builds one concept per significant term of the request', () => {
    expect(requestConcepts('What is the security deposit amount and is it refundable?')).toEqual([
      conceptOf('deposit'),
      conceptOf('refundable'),
    ]);
  });
});

describe('quoteMatchesRequest with synonyms', () => {
  it('keeps a quote that says deposit for a security deposit question', () => {
    const quote = 'The Licensee pays a refundable deposit of one or three months rent.';
    expect(quoteMatchesRequest(quote, 'What is the security deposit amount?')).toBe(true);
  });

  it('keeps a quote that says Lessor for a landlord question', () => {
    expect(quoteMatchesRequest('The Lessor may enter the premises on notice.', 'Can the landlord enter?')).toBe(true);
  });

  it('keeps a quote that says cancellation for a termination question', () => {
    expect(quoteMatchesRequest('Either party may cancel this licence by written notice.', 'What is the termination?')).toBe(true);
  });

  it('still rejects a quote that has only some of the concepts', () => {
    const quote = 'The Licensee pays a refundable fee.';
    expect(quoteMatchesRequest(quote, 'What is the security deposit and is it refundable?')).toBe(false);
  });

  it('still rejects a tenant question answered from a landlord clause', () => {
    expect(quoteMatchesRequest('The Licensor may terminate on notice.', 'What are the tenant obligations?')).toBe(false);
  });

  it('still rejects a deposit question answered from a rent-in-advance clause', () => {
    expect(quoteMatchesRequest('The rent is payable in advance on the first day.', 'What is the security deposit?')).toBe(false);
  });

  it('still rejects the payment-default notice for a termination question', () => {
    const quote = 'The Licensee shall cure any payment default within ten days after written notice of default.';
    expect(quoteMatchesRequest(quote, 'What is the notice period for termination?')).toBe(false);
  });

  it('still rejects the rate table for a deposit question', () => {
    const quote = 'Hardship compensation is payable at Rs. 70.00 per day of delay under Schedule B.';
    expect(quoteMatchesRequest(quote, 'What is the security deposit amount?')).toBe(false);
  });
});
