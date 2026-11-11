import type { AnalysisReport } from '../analysis/types';
import {
  clauseMatch,
  normToken,
  type GoldenExpectation,
  type GoldenFile,
  type GoldenKind,
} from '../analysis/goldenScore';
import { normalizeQuote } from '../analysis/verify';
import { EXPECTED_TOPICS } from '../analysis/crossClause';
import type { Task } from '../tasks/types';
import { DEFAULT_THRESHOLDS } from './config';
import type {
  AggregateBucket,
  AggregateScore,
  DocumentScore,
  FalseMissingCheck,
  LedgerCheck,
  LedgerCheckItem,
  OverviewCheck,
  OverviewIssue,
  PrecisionBucket,
  PrecisionResult,
  QualityThresholds,
  QuoteValidity,
  RecallResult,
  ScoreableKind,
} from './types';

export interface JudgementLike {
  parties: { a: string | null; b: string | null };
  rows: {
    clause: string;
    page: number;
    quote: string;
    direction: 'favours_a' | 'favours_b' | 'neutral';
    why: string;
  }[];
}

export interface ScoreInput {
  report: AnalysisReport;
  golden: GoldenFile;
  pages: Map<number, string>;
  tasks?: Task[];
  judgement?: JudgementLike | null;
  thresholds?: Partial<QualityThresholds>;
}

const KINDS: ScoreableKind[] = ['payment', 'date', 'obligation', 'favour', 'risk'];
const normText = (s: string) => normalizeQuote(s);

// A token matches when it appears in the item's support text, ignoring commas, spaces and
// dotted thousands separators ("18,000", "18.000" and "18000" are the same token).
const hasToken = (token: string, text: string): boolean => normToken(text).includes(normToken(token));

const hasContains = (contains: string | undefined, text: string): boolean =>
  !contains || normText(text).includes(normText(contains));

const judgementOf = (report: AnalysisReport, override?: JudgementLike | null): JudgementLike | null =>
  override ?? report.judgement ?? null;

const partyOf = (row: { direction: string }, parties: { a: string | null; b: string | null }): string | null =>
  row.direction === 'favours_a' ? parties.a : row.direction === 'favours_b' ? parties.b : null;

function paymentHit(g: GoldenExpectation, report: AnalysisReport): boolean {
  return report.clauses.some(
    (c) =>
      clauseMatch(g.clause, c.clauseNo) &&
      c.payments.some(
        (p) =>
          hasToken(g.token, `${p.amount} ${p.payer} ${p.payee} ${p.due} ${p.quote} ${c.summary}`) &&
          hasContains(g.contains, `${p.amount} ${p.due} ${p.quote}`),
      ),
  );
}

function itemHit(kind: GoldenKind, g: GoldenExpectation, report: AnalysisReport): boolean {
  if (kind === 'payment') return paymentHit(g, report);
  return report.clauses.some((c) => {
    if (!clauseMatch(g.clause, c.clauseNo)) return false;
    if (kind === 'date') {
      return c.dates.some(
        (d) =>
          hasToken(g.token, `${d.text} ${d.quote} ${c.summary}`) &&
          hasContains(g.contains, `${d.text} ${d.quote}`),
      );
    }
    if (kind === 'obligation') {
      return c.obligations.some(
        (o) =>
          hasToken(g.token, `${o.party} ${o.text} ${o.quote} ${c.summary}`) &&
          hasContains(g.contains, `${o.party} ${o.text} ${o.quote}`),
      );
    }
    if (kind === 'risk') {
      return c.risks.some(
        (r) =>
          hasToken(g.token, `${r.text} ${r.quote} ${c.summary}`) &&
          hasContains(g.contains, `${r.text} ${r.quote}`),
      );
    }
    return false;
  });
}

function codePaymentHit(g: GoldenExpectation, report: AnalysisReport): boolean {
  return (report.amounts?.code ?? []).some(
    (a) =>
      !a.text.includes('\n') &&
      a.text.trim().length > 2 &&
      clauseMatch(g.clause, a.clause) &&
      hasToken(g.token, `${a.text} ${a.quote}`) &&
      hasContains(g.contains, `${a.text} ${a.quote}`),
  );
}

function favourHit(g: GoldenExpectation, judgement: JudgementLike): boolean {
  return judgement.rows.some((r) => {
    const party = partyOf(r, judgement.parties);
    return (
      r.direction !== 'neutral' &&
      clauseMatch(g.clause, r.clause) &&
      (party ?? '').toLowerCase().includes(g.token.toLowerCase()) &&
      hasContains(g.contains, r.quote)
    );
  });
}

function emptyRecall(kind: GoldenKind): RecallResult {
  return {
    kind,
    expected: 0,
    modelFound: 0,
    combinedFound: 0,
    modelRecall: 1,
    combinedRecall: 1,
    available: true,
    modelMisses: [],
    combinedMisses: [],
  };
}

export function scoreRecall(
  report: AnalysisReport,
  expected: GoldenExpectation[],
  judgementInput?: JudgementLike | null,
): Record<ScoreableKind, RecallResult> {
  const judgement = judgementOf(report, judgementInput);
  const out = {} as Record<ScoreableKind, RecallResult>;
  for (const kind of KINDS) {
    const items = expected.filter((e) => e.kind === kind);
    if (kind === 'favour') {
      if (!judgement) {
        out[kind] = {
          ...emptyRecall(kind),
          expected: items.length,
          available: false,
          modelMisses: items,
          combinedMisses: items,
        };
        continue;
      }
      const misses = items.filter((g) => !favourHit(g, judgement));
      const found = items.length - misses.length;
      out[kind] = {
        kind,
        expected: items.length,
        modelFound: found,
        combinedFound: found,
        modelRecall: items.length ? found / items.length : 1,
        combinedRecall: items.length ? found / items.length : 1,
        available: true,
        modelMisses: misses,
        combinedMisses: misses,
      };
      continue;
    }
    const misses = items.filter((g) => !itemHit(kind, g, report));
    const found = items.length - misses.length;
    const combinedMisses =
      kind === 'payment' ? items.filter((g) => !itemHit(kind, g, report) && !codePaymentHit(g, report)) : misses;
    const combinedFound = items.length - combinedMisses.length;
    out[kind] = {
      kind,
      expected: items.length,
      modelFound: found,
      combinedFound,
      modelRecall: items.length ? found / items.length : 1,
      combinedRecall: items.length ? combinedFound / items.length : 1,
      available: true,
      modelMisses: misses,
      combinedMisses,
    };
  }
  return out;
}

interface ShownItem {
  kind: ScoreableKind;
  clause: string;
  text: string;
  quote: string;
}

// Every item the report shows to the user, in the form used for precision checks.
function shownItems(report: AnalysisReport, judgement: JudgementLike | null): ShownItem[] {
  const out: ShownItem[] = [];
  for (const c of report.clauses) {
    for (const p of c.payments)
      out.push({ kind: 'payment', clause: c.clauseNo, text: `${p.amount} ${p.payer} ${p.payee} ${p.due} ${p.quote} ${c.summary}`, quote: p.quote });
    for (const d of c.dates)
      out.push({ kind: 'date', clause: c.clauseNo, text: `${d.text} ${d.quote} ${c.summary}`, quote: d.quote });
    for (const o of c.obligations)
      out.push({ kind: 'obligation', clause: c.clauseNo, text: `${o.party} ${o.text} ${o.quote} ${c.summary}`, quote: o.quote });
    for (const r of c.risks)
      out.push({ kind: 'risk', clause: c.clauseNo, text: `${r.text} ${r.quote} ${c.summary}`, quote: r.quote });
  }
  if (judgement) {
    for (const r of judgement.rows) {
      if (r.direction === 'neutral') continue;
      const party = partyOf(r, judgement.parties);
      out.push({ kind: 'favour', clause: r.clause, text: `${party ?? ''} ${r.quote}`, quote: r.quote });
    }
  }
  return out;
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);

function bucket(shown: number, onList: number): PrecisionBucket {
  return { shown, onList, precision: ratio(onList, shown) };
}

export function scorePrecision(
  report: AnalysisReport,
  expected: GoldenExpectation[],
  judgementInput?: JudgementLike | null,
): PrecisionResult {
  const judgement = judgementOf(report, judgementInput);
  const shown = shownItems(report, judgement);
  const byKind = {} as Record<ScoreableKind, PrecisionBucket>;
  for (const kind of KINDS) {
    const listed = expected.filter((e) => e.kind === kind);
    const inListedClauses = shown.filter(
      (s) => s.kind === kind && listed.some((g) => clauseMatch(g.clause, s.clause)),
    );
    const onList = inListedClauses.filter((s) =>
      listed.some((g) => {
        if (!clauseMatch(g.clause, s.clause)) return false;
        if (s.kind === 'favour') {
          // The party name is part of the support text; contains is checked against the quote.
          const party = s.text.slice(0, Math.max(0, s.text.length - s.quote.length));
          return party.toLowerCase().includes(g.token.toLowerCase()) && hasContains(g.contains, s.quote);
        }
        return hasToken(g.token, s.text) && hasContains(g.contains, s.text);
      }),
    );
    byKind[kind] = bucket(inListedClauses.length, onList.length);
  }
  const all = Object.values(byKind);
  return {
    byKind,
    overall: bucket(
      all.reduce((n, b) => n + b.shown, 0),
      all.reduce((n, b) => n + b.onList, 0),
    ),
  };
}

interface ShownQuote {
  kind: string;
  clause: string;
  page: number | null;
  quote: string;
}

function collectQuotes(report: AnalysisReport, judgement: JudgementLike | null): ShownQuote[] {
  const out: ShownQuote[] = [];
  for (const c of report.clauses) {
    for (const p of c.payments) out.push({ kind: 'payment', clause: c.clauseNo, page: p.page, quote: p.quote });
    for (const d of c.dates) out.push({ kind: 'date', clause: c.clauseNo, page: d.page, quote: d.quote });
    for (const o of c.obligations) out.push({ kind: 'obligation', clause: c.clauseNo, page: o.page, quote: o.quote });
    for (const r of c.risks) out.push({ kind: 'risk', clause: c.clauseNo, page: r.page, quote: r.quote });
  }
  for (const r of judgement?.rows ?? []) out.push({ kind: 'judgement', clause: r.clause, page: r.page, quote: r.quote });
  return out;
}

// Re-checks every quote the run shows against the stored page it cites. A quote found on a
// different page is a page mismatch, not a valid citation.
export function checkQuoteValidity(
  report: AnalysisReport,
  pages: Map<number, string>,
  judgementInput?: JudgementLike | null,
): QuoteValidity {
  const judgement = judgementOf(report, judgementInput);
  const quotes = collectQuotes(report, judgement);
  const invalid: QuoteValidity['invalid'] = [];
  let valid = 0;
  const allNorm = new Map<number, string>();
  for (const [p, text] of pages) allNorm.set(p, normText(text));

  for (const q of quotes) {
    const quoteNorm = normText(q.quote);
    if (!quoteNorm) {
      invalid.push({ ...q, reason: 'not_found' });
      continue;
    }
    const cited = q.page !== null ? allNorm.get(q.page) : undefined;
    if (cited === undefined) {
      invalid.push({ ...q, reason: 'page_missing' });
      continue;
    }
    if (cited.includes(quoteNorm)) {
      valid++;
      continue;
    }
    let foundPage: number | undefined;
    for (const [p, text] of allNorm) {
      if (text.includes(quoteNorm)) {
        foundPage = p;
        break;
      }
    }
    invalid.push({ ...q, reason: foundPage === undefined ? 'not_found' : 'page_mismatch', foundPage });
  }
  return { total: quotes.length, valid, rate: ratio(valid, quotes.length), invalid };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A gap finding claims a topic is absent. The claim is false when the topic's own pattern
// occurs anywhere in the stored document text.
export function checkFalseMissing(
  report: AnalysisReport,
  pages: Map<number, string>,
): FalseMissingCheck {
  const claims = report.crossClause.findings.filter((f) => f.kind === 'gap');
  const falseClaims: FalseMissingCheck['falseClaims'] = [];
  for (const claim of claims) {
    const lower = claim.text.toLowerCase();
    const topic = EXPECTED_TOPICS.find((t) => lower.includes(t.label.toLowerCase()));
    let pattern = topic?.pattern;
    let label = topic?.label ?? '';
    if (!pattern) {
      const words = lower
        .replace(/^.*?covers\s+/, '')
        .replace(/;.*$/, '')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3);
      if (words.length === 0) continue;
      label = words.join(' ');
      pattern = new RegExp(words.map(escapeRe).join('|'), 'i');
    }
    let foundOnPage: number | null = null;
    for (const [page, text] of [...pages].sort((a, b) => a[0] - b[0])) {
      if (pattern.test(text)) {
        foundOnPage = page;
        break;
      }
    }
    if (foundOnPage !== null) falseClaims.push({ text: claim.text, topic: label, foundOnPage });
  }
  return {
    claims: claims.length,
    falseClaims,
    rate: ratio(falseClaims.length, claims.length),
  };
}

const rootOf = (taskId: string) => taskId.split('/')[0];

function check(name: string, ok: boolean, detail: string): LedgerCheckItem {
  return { name, ok, detail };
}

// The ledger must agree with the saved task rows, not only with itself.
export function checkLedger(report: AnalysisReport, tasks?: Task[]): LedgerCheck {
  const t = report.ledger.totals;
  const checks: LedgerCheckItem[] = [];
  const sum = (n: (c: AnalysisReport['ledger']['chunks'][number]) => number) =>
    report.ledger.chunks.reduce((acc, c) => acc + n(c), 0);

  checks.push(
    check(
      'processed chunks = sum of ledger chunks',
      t.chunksProcessed === report.ledger.chunks.filter((c) => c.processed).length,
      `${t.chunksProcessed} vs ${report.ledger.chunks.filter((c) => c.processed).length}`,
    ),
    check(
      'analysed clauses = sum of ledger chunks',
      t.clausesAnalysed === sum((c) => c.analysed),
      `${t.clausesAnalysed} vs ${sum((c) => c.analysed)}`,
    ),
    check(
      'verified clauses = sum of ledger chunks',
      t.clausesVerified === sum((c) => c.verified),
      `${t.clausesVerified} vs ${sum((c) => c.verified)}`,
    ),
    check(
      'analysed <= detected',
      t.clausesAnalysed <= t.clausesDetected,
      `${t.clausesAnalysed} of ${t.clausesDetected}`,
    ),
    check(
      'verified <= analysed',
      t.clausesVerified <= t.clausesAnalysed,
      `${t.clausesVerified} of ${t.clausesAnalysed}`,
    ),
    check(
      'verified items <= analysed items',
      t.itemsVerified <= t.itemsAnalysed,
      `${t.itemsVerified} of ${t.itemsAnalysed}`,
    ),
  );

  if (tasks) {
    checks.push(
      check(
        'metrics total tasks = saved tasks',
        report.metrics.totalTasks === tasks.length,
        `${report.metrics.totalTasks} vs ${tasks.length}`,
      ),
      check(
        'metrics done tasks = saved done tasks',
        report.metrics.doneTasks === tasks.filter((x) => x.status === 'done').length,
        `${report.metrics.doneTasks} vs ${tasks.filter((x) => x.status === 'done').length}`,
      ),
    );

    // First-pass chunk tasks are `${runId}:a${index}`. A split parent has done children, so
    // count the root id of any done task.
    const doneRoots = new Set(tasks.filter((x) => x.status === 'done').map((x) => rootOf(x.id)));
    const chunkRootPrefix = `${report.runId}:a`;
    const doneIndices = new Set(
      [...doneRoots]
        .filter((id) => id.startsWith(chunkRootPrefix) && /^\d+$/.test(id.slice(chunkRootPrefix.length)))
        .map((id) => Number(id.slice(chunkRootPrefix.length))),
    );
    checks.push(
      check(
        'processed chunks = done chunk tasks',
        t.chunksProcessed === doneIndices.size,
        `${t.chunksProcessed} vs ${doneIndices.size}`,
      ),
    );
    const falselyProcessed = report.ledger.chunks.filter((c) => c.processed && !doneIndices.has(c.index));
    checks.push(
      check(
        'no chunk processed without a done task',
        falselyProcessed.length === 0,
        falselyProcessed.map((c) => c.index).join(', ') || 'none',
      ),
    );
  }

  const mismatches = checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
  return { ok: mismatches.length === 0, checks, mismatches };
}

// Every overview cite must exist, and every number/month in the sentence must appear in the
// cited item text. Section-sentence IDs ("S1-2") are expanded through their own cites.
export function checkOverview(report: AnalysisReport): OverviewCheck {
  const support = new Map<string, string>();
  const add = (id: string, text: string) => support.set(id, `${support.get(id) ?? ''} ${text}`.trim());

  for (const c of report.clauses) {
    const base = `${c.clauseNo} ${c.type} ${c.summary}`;
    add(c.itemId, base);
    const addChild = (id: string, text: string) => {
      add(id, text);
      add(c.itemId, text);
    };
    for (const o of c.obligations) addChild(o.itemId, `${c.clauseNo} ${o.party} ${o.text} ${o.quote}`);
    for (const d of c.dates) addChild(d.itemId, `${c.clauseNo} ${d.text} ${d.quote}`);
    for (const p of c.payments) addChild(p.itemId, `${c.clauseNo} ${p.amount} ${p.payer} ${p.payee} ${p.due} ${p.quote}`);
    for (const r of c.risks) addChild(r.itemId, `${c.clauseNo} ${r.text} ${r.quote}`);
  }
  for (const section of report.sections) {
    for (let j = 0; j < section.sentences.length; j++) {
      const s = section.sentences[j];
      const cited = s.cites.map((id) => support.get(id) ?? '').join(' ');
      add(`S${section.section}-${j + 1}`, `${s.text} ${cited}`);
    }
  }

  const issues: OverviewIssue[] = [];
  for (const s of report.overview) {
    const unknownCites = s.cites.filter((id) => !support.has(id));
    const citedText = s.cites.map((id) => support.get(id) ?? '').join(' ');
    const unsupportedFigures = keyFigures(s.text).filter((f) => !hasToken(f, citedText));
    if (unknownCites.length || unsupportedFigures.length) {
      issues.push({ text: s.text, cites: s.cites, unknownCites, unsupportedFigures });
    }
  }
  return {
    sentences: report.overview.length,
    okSentences: report.overview.length - issues.length,
    rate: ratio(report.overview.length - issues.length, report.overview.length),
    issues,
  };
}

// Figures that a roll-up sentence asserts: numbers (including amounts and percentages) and
// month names. A sentence cannot assert a figure that none of its cited items contains.
export function keyFigures(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(normToken(m[0]));
  for (const m of text.matchAll(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/gi,
  ))
    out.add(m[1].toLowerCase());
  return [...out];
}

export function failuresFor(score: DocumentScore, thresholds: QualityThresholds): string[] {
  const failures: string[] = [];
  const r = score.recall;
  if (r.payment.expected > 0) {
    if (r.payment.modelRecall < thresholds.paymentRecallModel)
      failures.push(
        `payment recall (model) ${(r.payment.modelRecall * 100).toFixed(0)}% < ${(thresholds.paymentRecallModel * 100).toFixed(0)}%`,
      );
    if (r.payment.combinedRecall < thresholds.paymentRecallCombined)
      failures.push(
        `payment recall (model+code) ${(r.payment.combinedRecall * 100).toFixed(0)}% < ${(thresholds.paymentRecallCombined * 100).toFixed(0)}%`,
      );
  }
  const recallChecks: [ScoreableKind, number][] = [
    ['date', thresholds.dateRecall],
    ['obligation', thresholds.obligationRecall],
    ['risk', thresholds.riskRecall],
    ['favour', thresholds.favourRecall],
  ];
  for (const [kind, min] of recallChecks) {
    if (r[kind].expected > 0 && r[kind].available && r[kind].modelRecall < min)
      failures.push(`${kind} recall ${(r[kind].modelRecall * 100).toFixed(0)}% < ${(min * 100).toFixed(0)}%`);
  }
  if (score.precision.overall.shown > 0 && score.precision.overall.precision < thresholds.precision)
    failures.push(
      `precision ${(score.precision.overall.precision * 100).toFixed(0)}% < ${(thresholds.precision * 100).toFixed(0)}%`,
    );
  if (score.quoteValidity.total > 0 && score.quoteValidity.rate < thresholds.quoteValidity)
    failures.push(
      `quote validity ${(score.quoteValidity.rate * 100).toFixed(0)}% < ${(thresholds.quoteValidity * 100).toFixed(0)}%`,
    );
  if (score.falseMissing.falseClaims.length > thresholds.maxFalseMissingClaims)
    failures.push(
      `${score.falseMissing.falseClaims.length} false "missing" claim(s) > ${thresholds.maxFalseMissingClaims}`,
    );
  if (score.overview.sentences > 0 && score.overview.rate < thresholds.overviewFidelity)
    failures.push(
      `overview fidelity ${(score.overview.rate * 100).toFixed(0)}% < ${(thresholds.overviewFidelity * 100).toFixed(0)}%`,
    );
  if (score.metrics.failed > thresholds.maxFailedTasks)
    failures.push(`${score.metrics.failed} failed task(s) > ${thresholds.maxFailedTasks}`);
  if (thresholds.ledgerMustMatch && !score.ledger.ok)
    failures.push(`ledger does not match saved tasks (${score.ledger.mismatches.join('; ')})`);
  return failures;
}

export function scoreDocument(input: ScoreInput): DocumentScore {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const judgement = judgementOf(input.report, input.judgement);
  const expected = input.golden.expected;
  const recall = scoreRecall(input.report, expected, judgement);
  const score: DocumentScore = {
    doc: input.report.docName,
    runId: input.report.runId,
    model: input.report.model,
    createdAt: input.report.createdAt,
    holdout: input.golden.holdout === true,
    expected: expected.length,
    recall,
    precision: scorePrecision(input.report, expected, judgement),
    quoteValidity: checkQuoteValidity(input.report, input.pages, judgement),
    falseMissing: checkFalseMissing(input.report, input.pages),
    ledger: checkLedger(input.report, input.tasks),
    overview: checkOverview(input.report),
    metrics: {
      calls: input.report.metrics.calls,
      promptTokens: input.report.metrics.promptTokens,
      completionTokens: input.report.metrics.completionTokens,
      costUsd: input.report.metrics.costUsd,
      p95DurationMs: input.report.metrics.p95DurationMs,
      failed: input.report.metrics.failed,
      doneTasks: input.report.metrics.doneTasks,
      totalTasks: input.report.metrics.totalTasks,
    },
    pass: false,
    failures: [],
  };
  score.failures = failuresFor(score, thresholds);
  score.pass = score.failures.length === 0;
  return score;
}

function emptyBucket(): AggregateBucket {
  return {
    documents: 0,
    expected: 0,
    modelFound: 0,
    combinedFound: 0,
    recall: { model: 1, combined: 1 },
    byKind: {
      payment: { expected: 0, modelFound: 0, combinedFound: 0 },
      date: { expected: 0, modelFound: 0, combinedFound: 0 },
      obligation: { expected: 0, modelFound: 0, combinedFound: 0 },
      favour: { expected: 0, modelFound: 0, combinedFound: 0 },
      risk: { expected: 0, modelFound: 0, combinedFound: 0 },
    },
    precision: 1,
    quoteValidity: 1,
    falseMissingClaims: 0,
    overviewFidelity: 1,
    failedTasks: 0,
    calls: 0,
    costUsd: 0,
    passed: 0,
  };
}

function reduceBucket(scores: DocumentScore[]): AggregateBucket {
  const b = emptyBucket();
  if (scores.length === 0) return b;
  let shown = 0;
  let onList = 0;
  let quoteTotal = 0;
  let quoteValid = 0;
  let overviewSentences = 0;
  let overviewOk = 0;
  for (const s of scores) {
    b.documents++;
    for (const kind of KINDS) {
      const r = s.recall[kind];
      if (!r.available) continue;
      b.expected += r.expected;
      b.modelFound += r.modelFound;
      b.combinedFound += r.combinedFound;
      b.byKind[kind].expected += r.expected;
      b.byKind[kind].modelFound += r.modelFound;
      b.byKind[kind].combinedFound += r.combinedFound;
    }
    shown += s.precision.overall.shown;
    onList += s.precision.overall.onList;
    quoteTotal += s.quoteValidity.total;
    quoteValid += s.quoteValidity.valid;
    overviewSentences += s.overview.sentences;
    overviewOk += s.overview.okSentences;
    b.falseMissingClaims += s.falseMissing.falseClaims.length;
    b.failedTasks += s.metrics.failed;
    b.calls += s.metrics.calls;
    b.costUsd += s.metrics.costUsd;
    if (s.pass) b.passed++;
  }
  b.recall = {
    model: ratio(b.modelFound, b.expected),
    combined: ratio(b.combinedFound, b.expected),
  };
  b.precision = ratio(onList, shown);
  b.quoteValidity = ratio(quoteValid, quoteTotal);
  b.overviewFidelity = ratio(overviewOk, overviewSentences);
  return b;
}

// Hold-outs are scored but kept out of tuning aggregates.
export function aggregateScores(scores: DocumentScore[]): AggregateScore {
  return {
    tuning: reduceBucket(scores.filter((s) => !s.holdout)),
    holdout: reduceBucket(scores.filter((s) => s.holdout)),
  };
}
