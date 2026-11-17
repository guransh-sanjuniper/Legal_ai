import { describe, it, expect } from 'vitest';
import { classifyPrompt, partForQuote, promptDepth, splitPromptParts, stripAnswerIds } from './promptShape';
import { PROMPT_OVERFLOW_HEADING } from './promptShape';

describe('prompt parts', () => {
  it('splits separate questions and keeps the user wording as the heading', () => {
    const parts = splitPromptParts('What is the security deposit? When is it refunded?');
    expect(parts.map((p) => p.text)).toEqual(['What is the security deposit?', 'When is it refunded?']);
    expect(parts.map((p) => p.heading)).toEqual(['What is the security deposit?', 'When is it refunded?']);
  });

  it('splits numbered and bulleted lists, one item per part', () => {
    expect(splitPromptParts('1. What is the deposit?\n2. Who holds it?').map((p) => p.text)).toEqual([
      'What is the deposit?',
      'Who holds it?',
    ]);
    expect(splitPromptParts('- What is the deposit\n- When is it refunded').map((p) => p.text)).toEqual([
      'What is the deposit',
      'When is it refunded',
    ]);
  });

  it('keeps one sentence and joined subjects together', () => {
    const single = splitPromptParts('Explain how rent and deposit are paid.');
    expect(single).toHaveLength(1);
    expect(single[0]).toEqual({ heading: null, text: 'Explain how rent and deposit are paid.' });
    // "and"/"or" never split: one subject, not two questions.
    expect(splitPromptParts('What are the rent and deposit terms?')).toHaveLength(1);
  });

  it('does not split a semicolon unless a new question follows it', () => {
    expect(splitPromptParts('The deposit is refundable; it is held by the landlord.')).toHaveLength(1);
    expect(splitPromptParts('Who holds the deposit; when is it refunded?').map((p) => p.text)).toEqual([
      'Who holds the deposit',
      'when is it refunded?',
    ]);
  });

  it('merges a very short fragment into the part before it', () => {
    const parts = splitPromptParts('What is the security deposit? Why?');
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe('What is the security deposit? Why?');
  });

  it('caps the number of parts and answers the rest together under a plain heading', () => {
    const request = Array.from({ length: 8 }, (_, i) => `Question ${i + 1} about the deposit?`).join(' ');
    const parts = splitPromptParts(request);
    expect(parts).toHaveLength(6);
    expect(parts[5].heading).toBe(PROMPT_OVERFLOW_HEADING);
    expect(parts[5].text).toContain('Question 6');
    expect(parts[5].text).toContain('Question 8');
  });

  it('gives no heading for a single-part request', () => {
    expect(splitPromptParts('What is the deposit?')[0].heading).toBeNull();
  });
});

describe('prompt depth', () => {
  it('classifies a short question, a broad request and a list request', () => {
    expect(classifyPrompt('Who may terminate the agreement on notice?')).toBe('narrow');
    expect(classifyPrompt('Explain how the deposit is refunded.')).toBe('broad');
    expect(classifyPrompt('List all payments the tenant must make.')).toBe('list');
    expect(classifyPrompt('The tenant pays rent monthly and the landlord pays the taxes under this long agreement, which also covers repairs, insurance and many other matters that the parties agreed between them in writing.')).toBe(
      'standard',
    );
  });

  it('reads extra sections only for broad and list requests', () => {
    expect(promptDepth('Who may terminate?').breadth).toBe(0);
    expect(promptDepth('Explain the deposit terms.').breadth).toBeGreaterThan(0);
    expect(promptDepth('List all payments.').breadth).toBeGreaterThan(0);
    expect(promptDepth('Who may terminate?').maxAnswerTokens).toBe(800);
    expect(promptDepth('List all payments.').maxAnswerTokens).toBe(3000);
  });

  it('assigns a rejected quote to the part whose concepts it carries', () => {
    const parts = splitPromptParts('What is the security deposit? When may the agreement be terminated?');
    expect(partForQuote('the security deposit is refundable', parts)).toBe(0);
    expect(partForQuote('either party may terminate on sixty days notice', parts)).toBe(1);
    expect(partForQuote('the premises must be vacated', parts)).toBe(0);
  });
});

describe('answer id stripping', () => {
  const ids = ['PA1', 'PA2', 'PQ10'];

  it('removes id references the model wrote into the text', () => {
    expect(stripAnswerIds('The deposit is refundable [PA1].', ids)).toBe('The deposit is refundable.');
    expect(stripAnswerIds('PA2 states that the deposit is refundable.', ids)).toBe('states that the deposit is refundable.');
    expect(stripAnswerIds('The fee is refundable (PQ10).', ids)).toBe('The fee is refundable.');
  });

  it('never removes a longer id or an ordinary word', () => {
    expect(stripAnswerIds('The deposit is refundable [PA10].', ids)).toBe('The deposit is refundable [PA10].');
    expect(stripAnswerIds('The deposit is refundable.', ids)).toBe('The deposit is refundable.');
  });
});
