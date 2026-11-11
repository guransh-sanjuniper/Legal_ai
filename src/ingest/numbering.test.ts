import { describe, it, expect } from 'vitest';
import { buildUnits, classifyLine } from './chunk';

const units = (text: string) => buildUnits([{ pageNo: 1, text }]);
const clauseNos = (text: string) => units(text).filter((u) => u.startKind === 'clause').map((u) => u.clauseNo);
const subNos = (text: string) => units(text).filter((u) => u.startKind === 'subclause').map((u) => u.clauseNo);
const sectionCount = (text: string) => units(text).filter((u) => u.startKind === 'section').length;

describe('numbering styles (synthetic text)', () => {
  it('"1." top-level clauses', () => {
    expect(clauseNos('1. Definitions\nbody text\n2. Payment\nbody text\n3. End\nbody')).toEqual(['1', '2', '3']);
  });

  it('"1.1" sub-clauses sit under their top clause', () => {
    const text = '1. Definitions\n1.1 First term.\n1.2 Second term.\n2. Payment\n2.1 Pay on time.';
    expect(clauseNos(text)).toEqual(['1', '2']);
    expect(subNos(text)).toEqual(['1.1', '1.2', '2.1']);
  });

  it('"1.1.1" sub-sub-clauses', () => {
    const text = '1. Scope\n1.1 Outer item.\n1.1.1 Inner item.\n1.1.2 Second inner item.\n2. Next\nbody';
    expect(clauseNos(text)).toEqual(['1', '2']);
    expect(subNos(text)).toEqual(['1.1', '1.1.1', '1.1.2']);
  });

  it('"1)" clauses', () => {
    expect(clauseNos('1) Alpha\nbody\n2) Beta\nbody\n3) Gamma\nbody')).toEqual(['1', '2', '3']);
  });

  it('"(1)" clauses', () => {
    expect(clauseNos('(1) Alpha\nbody\n(2) Beta\nbody\n(3) Gamma\nbody')).toEqual(['1', '2', '3']);
  });

  it('"Clause N" headings', () => {
    expect(clauseNos('Clause 1 Title\nbody\nClause 2 Title\nbody')).toEqual(['1', '2']);
  });

  it('"Article IV" headings are section boundaries', () => {
    expect(sectionCount('Article I Title\nbody\nArticle II Title\nbody')).toBe(2);
  });

  it('"Section N" headings', () => {
    expect(clauseNos('Section 1 Title\nbody\nSection 2 Title\nbody')).toEqual(['1', '2']);
  });

  it('"ARTICLE N: TITLE" headings are section boundaries', () => {
    expect(sectionCount('ARTICLE 1: DEFINITIONS\nbody\nARTICLE 2: TERM\nbody')).toBe(2);
    expect(classifyLine('ARTICLE 3: PAYMENTS')).toEqual({ kind: 'section', label: 'ARTICLE 3' });
  });
});

describe('sequence rule', () => {
  it('a jump that does not continue the sequence is not a boundary', () => {
    expect(clauseNos('1) Alpha\nbody\n1) Repeat\nbody\n5) Jump\nbody\n2) Beta\nbody')).toEqual(['1', '2']);
  });

  it('a numbered list inside a clause is not a boundary', () => {
    const text = '4) Obligations\n(1) first duty\n(2) second duty\n(3) third duty\n5) Next clause\nbody';
    expect(clauseNos(text)).toEqual(['4', '5']);
  });

  it('a bracketed preamble list does not start the clause sequence in a dotted document', () => {
    const text = '(1) Party one of the parties.\n(2) Party two of the parties.\n1. Definitions\nbody\n2. Payment\nbody';
    expect(clauseNos(text)).toEqual(['1', '2']);
  });

  it('a piece of a dotted document reads its bracketed lists as lists when the document flag is passed', () => {
    const piece = [{ pageNo: 1, text: '(1) Mrs A of the group\n(2) Mr B of the group' }];
    expect(buildUnits(piece, { strict: true }).filter((u) => u.clauseNo !== null)).toEqual([]);
    expect(buildUnits(piece, { strict: false }).filter((u) => u.clauseNo !== null).map((u) => u.clauseNo)).toEqual(['1', '2']);
  });

  it('a document that only uses bracket numbers starts at its first bracket clause', () => {
    expect(clauseNos('(1) Alpha\nbody\n(2) Beta\nbody')).toEqual(['1', '2']);
  });

  it('a bracketed list under a dotted clause is not a boundary', () => {
    const text = '1. Definitions\n(1) first term means one thing.\n(2) second term means another thing.\n2. Payment\nbody';
    expect(clauseNos(text)).toEqual(['1', '2']);
  });

  it('a table inside a clause is not a boundary', () => {
    const text = '16) Payments\nSr.\nno.\n1. Mr. A Rs. 100\n2. Mr. B Rs. 200\n3. Mr. C Rs. 300\n17) Next\nbody';
    expect(clauseNos(text)).toEqual(['16', '17']);
  });
});
