import { useState, type ReactNode } from 'react';
import {
  LAW_LABEL,
  NOT_STATED,
  REPORT_FOOTER,
  type Citation,
  type ClauseView,
  type PromptResultSentenceView,
  type PromptResultStatsView,
  type ReportModel,
  type ReportSection,
  type RiskRow,
} from '../../analysis/reportModel';
import { NOT_CLEAR_ANSWER } from '../../analysis/promptPass';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pagesLabel = (start: number, end: number) => (start === end ? `page ${start}` : `pages ${start}–${end}`);

// A marker in the Prompt Result text: jumps to the numbered source row, which opens the page.
function jumpToSource(n: number) {
  const el = document.getElementById(`prompt-source-${n}`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('ana-source-row--flash');
  window.setTimeout(() => el.classList.remove('ana-source-row--flash'), 1500);
}

function SentenceText({ s }: { s: PromptResultSentenceView }) {
  return (
    <>
      {s.text}
      {s.markers.map((n) => (
        <button key={n} type="button" className="ana-cite ana-marker" title={`Go to source ${n}`} onClick={() => jumpToSource(n)}>
          [{n}]
        </button>
      ))}
    </>
  );
}

// Paragraphs and bullet lists in the order the answer gives them.
function PromptSentences({ sentences }: { sentences: PromptResultSentenceView[] }) {
  const out: ReactNode[] = [];
  let bullets: PromptResultSentenceView[] = [];
  const flush = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    out.push(
      <ul key={`ul-${out.length}`} className="ana-list">
        {items.map((s, i) => (
          <li key={i}>
            <SentenceText s={s} />
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  for (const s of sentences) {
    if (s.style === 'bullet') {
      bullets.push(s);
      continue;
    }
    flush();
    out.push(
      <p key={`p-${out.length}`} className="ana-answer">
        <SentenceText s={s} />
      </p>,
    );
  }
  flush();
  return <>{out}</>;
}

// Small coverage line so the reader can judge how much of the document the answer read.
export function promptStatsLine(s: PromptResultStatsView): string {
  const range =
    s.pageStart === null || s.pageEnd === null
      ? ''
      : s.pageStart === s.pageEnd
        ? ` from page ${s.pageStart}`
        : ` from pages ${s.pageStart}–${s.pageEnd}`;
  const lines = [`Based on ${s.cited} passage${s.cited === 1 ? '' : 's'}${range}.`];
  if (s.excluded > 0) {
    lines.push(`${s.excluded} quote${s.excluded === 1 ? ' was' : 's were'} not relevant to the request and ${s.excluded === 1 ? 'is' : 'are'} not used.`);
  }
  if (s.readSections) {
    const more = s.moreSections ? `; ${s.moreSections} matching section${s.moreSections === 1 ? '' : 's'} not read` : '';
    lines.push(`${s.readSections} extra section${s.readSections === 1 ? '' : 's'} read for coverage${more}.`);
  }
  return lines.join(' ');
}

function Cite({ c, onCite }: { c: Citation; onCite: (c: Citation) => void }) {
  return (
    <button type="button" className="ana-cite" title={c.quote || 'Open the page'} onClick={() => onCite(c)}>
      Clause {c.clause} · p. {c.page}
    </button>
  );
}

function Card({ id, title, right, children, defaultOpen = true }: { id?: string; title: string; right?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section id={id} className="ana-card">
      <button type="button" className="ana-card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ana-card-title">{title}</span>
        {right}
        <span className="ana-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="ana-card-body">{children}</div>}
    </section>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="ana-badge">{children}</span>;
}

function PriorityChip({ level }: { level: string }) {
  const tone = level === 'high' ? 'danger' : level === 'medium' ? 'warn' : 'neutral';
  return <span className={`app-chip app-chip--${tone}`}>{cap(level)}</span>;
}

function ClauseTable({ clause, onCite }: { clause: ClauseView; onCite: (c: Citation) => void }) {
  const risk = clause.topPriority ? `${cap(clause.topPriority)} · ${plural(clause.riskCount, 'risk')}` : 'None identified';

  const fixed: [string, ReactNode][] = [
    ['Section', `Clause ${clause.clauseNo}${clause.type ? ` · ${clause.type}` : ''}`],
    ['Pages', pagesLabel(clause.pageStart, clause.pageEnd)],
    ['Risk', risk],
  ];
  const rows: [string, ReactNode][] = clause.rows.map((r) => {
    if (r.label === 'Quoted text') {
      return [
        r.label,
        r.citations.length === 0 ? NOT_STATED : (
          <ul className="ana-quotes">
            {r.citations.map((c, i) => (
              <li key={i}>
                <blockquote>“{c.quote}”</blockquote>
                <Cite c={c} onCite={onCite} />
              </li>
            ))}
          </ul>
        ),
      ];
    }
    if (r.items.length > 0) {
      return [
        r.label,
        <>
          <ul className="ana-list">
            {r.items.map((item, i) => (
              <li key={i}>
                {item}
                {r.citations[i] && (
                  <>
                    {' '}
                    <Cite c={r.citations[i]} onCite={onCite} />
                  </>
                )}
              </li>
            ))}
          </ul>
          {r.label === 'Law references' && <div className="ana-note">Labelled {LAW_LABEL}.</div>}
        </>,
      ];
    }
    if (r.text) {
      return [r.label, <>{r.text} {r.modelWritten && <Badge>model-written</Badge>}</>];
    }
    return [r.label, <span className="app-muted">{NOT_STATED}</span>];
  });

  return (
    <table className="app-table ana-clause-table">
      <tbody>
        {[...fixed, ...rows].map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ClauseBreakdown({ clauses, onCite, stats }: { clauses: ClauseView[]; onCite: (c: Citation) => void; stats: ReportModel['merge'] }) {
  return (
    <>
      <p className="app-muted">
        {stats.entries} stored entries → {stats.rows} clause rows. {stats.placed} unnumbered entries placed by their quotes or chunk; {stats.merged} merged
        into another row; {stats.unmerged} kept separate because they could not be placed.
      </p>
      {clauses.length === 0 && <p className="app-muted">No clauses were analysed.</p>}
      {clauses.map((c) => (
        <Card
          key={c.key}
          id={`clause-${c.key}`}
          title={`Clause ${c.clauseNo}${c.type ? ` · ${c.type}` : ''}`}
          right={
            <span className="ana-card-chips">
              {c.topPriority && <PriorityChip level={c.topPriority} />}
              {c.unplaced && <Badge>unplaced entry</Badge>}
              {c.sourceEntries > 1 && <Badge>merged from {c.sourceEntries}</Badge>}
            </span>
          }
          defaultOpen={false}
        >
          <ClauseTable clause={c} onCite={onCite} />
        </Card>
      ))}
    </>
  );
}

function RiskTable({ rows, onCite }: { rows: RiskRow[]; onCite: (c: Citation) => void }) {
  if (rows.length === 0) return <p className="app-muted">None.</p>;
  return (
    <div className="app-table-wrap">
      <table className="app-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Level</th>
            <th>Clause and page</th>
            <th>Affects</th>
            <th>Issue</th>
            <th>Law references</th>
            <th>Suggested next steps</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>
                <PriorityChip level={r.priority} />
              </td>
              <td>
                <div>Clause {r.clause}</div>
                {r.citation ? <Cite c={r.citation} onCite={onCite} /> : <span className="app-muted">{r.pages || 'Whole document'}</span>}
              </td>
              <td>{r.affects}</td>
              <td>{r.issue}</td>
              <td>
                {r.laws.length ? (
                  <>
                    <ul className="ana-list">
                      {r.laws.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                    <div className="ana-note">{LAW_LABEL}</div>
                  </>
                ) : (
                  <span className="app-muted">None named</span>
                )}
              </td>
              <td>{r.suggestion}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionBody({
  section,
  onCite,
  model,
  onScanWhole,
}: {
  section: ReportSection;
  onCite: (c: Citation) => void;
  model: ReportModel;
  onScanWhole?: () => void;
}) {
  switch (section.key) {
    case 'overview':
      return (
        <>
          {section.points.map((p) => (
            <div key={p.title} className="ana-point">
              <h4>{p.title}</h4>
              {p.note && <div className="ana-note">{p.note}</div>}
              {p.sentences.length === 0 ? (
                <p className="app-muted">{NOT_STATED}</p>
              ) : (
                <p className="ana-answer">
                  {p.sentences.map((s, i) => (
                    <span key={i}>
                      {s.text}{' '}
                      {s.citations.map((c, j) => (
                        <Cite key={j} c={c} onCite={onCite} />
                      ))}{' '}
                    </span>
                  ))}
                </p>
              )}
              {p.title === 'Statutory Compliance' && <div className="ana-note">Each law is labelled {LAW_LABEL}.</div>}
            </div>
          ))}
        </>
      );
    case 'promptResult':
      return (
        <>
          <p className="app-muted">Prompt: “{section.prompt}”</p>
          {section.modeLine && <p className="app-muted">{section.modeLine}</p>}
          {section.canScanWhole && onScanWhole && (
            <button type="button" className="app-link-button" onClick={onScanWhole}>
              Scan whole document
            </button>
          )}
          {section.truncatedNote && (
            <div className="app-banner app-banner--notice ana-banner" role="status">
              {section.truncatedNote}
            </div>
          )}
          {(section.parts ?? []).length === 0 ? (
            section.error ? <p className="app-banner app-banner--error">{section.error}</p> : <p className="app-muted">Not found in this document.</p>
          ) : (
            (section.parts ?? []).map((part, i) => (
              <div key={i} className="ana-prompt-part">
                {part.heading && <h4>{part.heading}</h4>}
                <PromptSentences sentences={part.sentences} />
                {part.notStated && part.sentences.length === 0 && <p className="app-muted">{NOT_CLEAR_ANSWER}</p>}
                {part.truncated && <p className="ana-note">This part was cut off at the output limit and may be incomplete.</p>}
                {part.error && <p className="app-banner app-banner--error">{part.error}</p>}
              </div>
            ))
          )}
          {section.stats && section.stats.cited > 0 && <p className="ana-note">{promptStatsLine(section.stats)}</p>}
          {(section.sources ?? []).length > 0 && (
            <div className="ana-prompt-sources">
              <h4>{(section.parts ?? []).some((p) => p.sentences.length > 0) ? 'Sources' : 'Verified quotes'}</h4>
              <ol className="ana-source-list">
                {(section.sources ?? []).map((s) => (
                  <li key={s.n} id={`prompt-source-${s.n}`} className="ana-source-row">
                    <span className="ana-source-n">[{s.n}]</span>
                    <div className="ana-source-body">
                      <button type="button" className="ana-cite" onClick={() => onCite(s.citation)}>
                        {s.clause ? `Clause ${s.clause} · p. ${s.page}` : `p. ${s.page}`}
                      </button>
                      <blockquote>“{s.quote}”</blockquote>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <p className="app-muted">
            Chunks answered {section.chunksDone} of {section.chunksTotal}.
            {section.failed.length > 0 && <> Not answered: {section.failed.join('; ')}.</>}
          </p>
        </>
      );
    case 'clauses':
      return <ClauseBreakdown clauses={model.clauses} onCite={onCite} stats={model.merge} />;
    case 'datesAmounts':
      return (
        <>
          <h4>Dates</h4>
          {section.dates.length === 0 ? (
            <p className="app-muted">No dates with a stated purpose were found.</p>
          ) : (
            <div className="app-table-wrap">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>What it is</th>
                    <th>Fixed or relative</th>
                    <th>Clause</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {section.dates.map((r, i) => (
                    <tr key={i}>
                      <td>{r.date}</td>
                      <td>{r.purpose}</td>
                      <td>{r.timing}</td>
                      <td>{r.clause}</td>
                      <td><Cite c={r.citation} onCite={onCite} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h4>Amounts</h4>
          {section.amounts.length === 0 ? (
            <p className="app-muted">No amounts were found.</p>
          ) : (
            <div className="app-table-wrap">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>Amount</th>
                    <th>What it is for</th>
                    <th>Payer to payee</th>
                    <th>When due</th>
                    <th>Clause</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {section.amounts.map((r, i) => (
                    <tr key={i}>
                      <td>{r.amount}</td>
                      <td>{r.purpose}</td>
                      <td>{r.payerToPayee}</td>
                      <td>{r.due}</td>
                      <td>{r.clause}</td>
                      <td><Cite c={r.citation} onCite={onCite} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      );
    case 'obligations':
      return section.groups.length === 0 ? (
        <p className="app-muted">No obligations were found in the verified items.</p>
      ) : (
        section.groups.map((g) => (
          <div key={g.party} className="ana-point">
            <h4>{g.party}</h4>
            <ul className="ana-list">
              {g.rows.map((r, i) => (
                <li key={i}>
                  {r.text} <Cite c={r.citation} onCite={onCite} />
                </li>
              ))}
            </ul>
          </div>
        ))
      );
    case 'risks':
      return (
        <>
          {section.reviewLine && <p className="app-muted">{section.reviewLine}</p>}
          <h4>Risks</h4>
          <RiskTable rows={section.risks} onCite={onCite} />
          <h4>Missing clauses and protections</h4>
          {section.missingLine && <p className="app-muted">{section.missingLine}</p>}
          <RiskTable rows={section.missing} onCite={onCite} />
          {section.possiblyMissing.length > 0 && (
            <>
              <h4>Possibly missing (not verified by search)</h4>
              <p className="app-muted">
                The document search failed or found nothing for these topics, so the absence is not verified. A lawyer should check each one.
              </p>
              <RiskTable rows={section.possiblyMissing} onCite={onCite} />
            </>
          )}
          {section.missingDrops.length > 0 && (
            <details className="ana-drops">
              <summary>Dropped by search ({section.missingDrops.length})</summary>
              <ul className="ana-list">
                {section.missingDrops.map((d, i) => (
                  <li key={i}>
                    {d.topic} — matched on page {d.page || 'unknown'}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {section.drops.length > 0 && (
            <details className="ana-drops">
              <summary>Validation drops ({section.drops.length})</summary>
              <ul className="ana-list">
                {section.drops.map((d, i) => (
                  <li key={i}>
                    Clause {d.clause}: {d.issue} — {d.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="app-muted">Priority is High only for void or unenforceable terms, illegal terms, statutory violations or major financial exposure.</p>
        </>
      );
    case 'inconsistencies':
      return section.findings.length === 0 ? (
        <p className="app-muted">No inconsistency was found by the checks.</p>
      ) : (
        <ul className="ana-list">
          {section.findings.map((f, i) => (
            <li key={i}>
              {f.text}{' '}
              {f.citations.map((c, j) => (
                <Cite key={j} c={c} onCite={onCite} />
              ))}
            </li>
          ))}
        </ul>
      );
    case 'coverage':
      // TODO: remove before final product (coverage is a testing aid).
      return (
        <ul className="ana-list">
          {section.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      );
  }
}

export function ReportView({
  model,
  onCite,
  onScanWhole,
}: {
  model: ReportModel;
  onCite: (c: Citation) => void;
  onScanWhole?: () => void;
}) {
  const t = model.title;
  return (
    <article className="ana-report">
      <header className="ana-title-block">
        <h2>Deep Analysis Report</h2>
        <dl className="ana-title-grid">
          <dt>Matter</dt><dd>{t.matter}</dd>
          <dt>Document</dt><dd>{t.document}</dd>
          <dt>Review date</dt><dd>{t.reviewDate}</dd>
          <dt>Detail level</dt><dd>{t.detailLevel}</dd>
          <dt>Focus</dt><dd>{t.focus}</dd>
          <dt>Reviewing for</dt><dd>{t.reviewingFor}</dd>
        </dl>
      </header>

      {model.banner.length > 0 && (
        <div className="app-banner app-banner--notice ana-banner" role="status">
          <strong>Partial report.</strong> {model.banner.join(' ')}
        </div>
      )}
      {model.unreviewed && (
        <div className="app-banner app-banner--notice ana-banner" role="status">
          <strong>Pages not reviewed.</strong> {model.unreviewed}
        </div>
      )}

      <nav className="ana-toc" aria-label="Table of contents">
        <div className="ana-card-title">Table of Contents</div>
        <ol>
          {model.toc.map((s) => (
            <li key={s.key}>
              <a href={`#sec-${s.key}`}>{s.title}</a>
            </li>
          ))}
        </ol>
      </nav>

      {model.sections.map((s) => (
        <Card key={s.key} id={`sec-${s.key}`} title={`${s.number}. ${s.title}`} defaultOpen={s.key !== 'clauses'}>
          <SectionBody section={s} onCite={onCite} model={model} onScanWhole={onScanWhole} />
        </Card>
      ))}

      <footer className="ana-footer">{REPORT_FOOTER}</footer>
    </article>
  );
}
