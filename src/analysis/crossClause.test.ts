import { describe, it, expect } from 'vitest';
import { findContradictions, missingTopicCandidates, parseAmount, paymentTotals } from './crossClause';

describe('payment totals', () => {
  const payments = [
    { itemId: 'a', clause: '1', amount: 'Rs. 10,00,000', payer: 'Purchaser', payee: 'Developer', due: 'booking', page: 1 },
    { itemId: 'b', clause: '2', amount: 'Rs. 2,50,000', payer: 'purchaser', payee: 'developer', due: 'second', page: 2 },
    { itemId: 'c', clause: '3', amount: '10% of price', payer: 'Purchaser', payee: 'Developer', due: 'third', page: 3 },
  ];

  it('parses Indian-formatted currency and ignores percentages for totals', () => {
    expect(parseAmount('Rs. 1,25,00,000/-')).toBe(12500000);
    expect(parseAmount('₹ 52.50')).toBe(52.5);
    expect(parseAmount('10% of price')).toBeNull();
  });

  it('totals per payer and payee, case-insensitively', () => {
    const totals = paymentTotals(payments);
    expect(totals).toHaveLength(1);
    expect(totals[0].payer).toBe('Purchaser');
    expect(totals[0].count).toBe(3);
    expect(totals[0].numericTotal).toBeNull(); // one percentage entry makes a numeric total unsafe
  });

  it('sums when all amounts are numeric', () => {
    const totals = paymentTotals(payments.slice(0, 2));
    expect(totals[0].numericTotal).toBe(1250000);
  });
});

describe('cross-clause contradictions', () => {
  it('flags the same date with different timing types', () => {
    const findings = findContradictions([
      { clause: '1', itemId: 'a', dates: [{ text: '31 March 2027', timing_type: 'fixed', itemId: 'a:1' }], payments: [] },
      { clause: '2', itemId: 'b', dates: [{ text: '31 March 2027', timing_type: 'event_relative', itemId: 'b:1' }], payments: [] },
    ]);
    expect(findings.some((f) => f.kind === 'contradiction' && f.text.includes('31 March 2027'))).toBe(true);
  });

  it('flags the same due date with different amounts', () => {
    const findings = findContradictions([
      { clause: '1', itemId: 'a', dates: [], payments: [{ due: 'on booking', amount: 'Rs. 1,00,000', itemId: 'a:1' }] },
      { clause: '2', itemId: 'b', dates: [], payments: [{ due: 'on booking', amount: 'Rs. 2,00,000', itemId: 'b:1' }] },
    ]);
    expect(findings.some((f) => f.severity === 'high')).toBe(true);
  });
});

describe('gap candidates', () => {
  it('lists topics absent from structured data only', () => {
    const missing = missingTopicCandidates([
      { type: 'possession', summary: 'Developer hands over possession', text: 'possession handover' },
      { type: 'payment', summary: 'Instalments payable', text: 'payment' },
    ]);
    expect(missing.map((m) => m.label)).toContain('termination');
    expect(missing.map((m) => m.label)).not.toContain('possession');
  });
});
