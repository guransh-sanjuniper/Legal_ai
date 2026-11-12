import { useState, type ReactNode } from 'react';
import {
  LAW_LABEL,
  NOT_STATED,
  REPORT_FOOTER,
  type Citation,
  type ClauseView,
  type ReportModel,
  type ReportSection,
  type RiskRow,
} from '../../analysis/reportModel';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pagesLabel = (start: number, end: number) => (start === end ? `page ${start}` : `pages ${start}–${end}`);

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
  const missing =
    clause.missing === null ? 'Not checked (older report)' : clause.missing.length === 0 ? 'None' : clause.missing.join('; ');
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
        {[...fixed, ...rows, ['Missing', missing]].map(([label, value]) => (
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

function SectionBody({ section, onCite, model }: { section: ReportSection; onCite: (c: Citation) => void; model: ReportModel }) {
  switch (section.key) {
    case 'overview':
      return (
        <>
          {section.points.map((p) => (
            <div key={p.title} className="ana-point">
              <h4>{p.title}</h4>
              {p.sentences.length === 0 ? (
                <p className="app-muted">{NOT_STATED}</p>
              ) : (
                <ul className="ana-list">
                  {p.sentences.map((s, i) => (
                    <li key={i}>
                      {s.text}{' '}
                      {s.citations.map((c, j) => (
                        <Cite key={j} c={c} onCite={onCite} />
                      ))}
                    </li>
                  ))}
                </ul>
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
          {section.answers.length === 0 ? (
            <p className="app-muted">No verified answer was found in the document.</p>
          ) : (
            <ul className="ana-list">
              {section.answers.map((a, i) => (
                <li key={i}>
                  {a.text} <Cite c={a.citation} onCite={onCite} />
                  <blockquote>“{a.citation.quote}”</blockquote>
                </li>
              ))}
            </ul>
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
      return section.rows.length === 0 ? (
        <p className="app-muted">No dates or amounts were found in the verified items.</p>
      ) : (
        <div className="app-table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Clause</th>
                <th>Detail</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {section.rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.kind}</td>
                  <td>{r.clause}</td>
                  <td>{r.detail}</td>
                  <td><Cite c={r.citation} onCite={onCite} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
    case 'timeline':
      return section.rows.length === 0 ? (
        <p className="app-muted">No dates were found in the verified items.</p>
      ) : (
        <div className="app-table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Event</th>
              </tr>
            </thead>
            <tbody>
              {section.rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.date}</td>
                  <td>{r.event} <Cite c={r.citation} onCite={onCite} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'risks':
      return (
        <>
          <h4>Risks</h4>
          <RiskTable rows={section.risks} onCite={onCite} />
          <h4>Missing clauses and protections</h4>
          <RiskTable rows={section.missing} onCite={onCite} />
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

export function ReportView({ model, onCite }: { model: ReportModel; onCite: (c: Citation) => void }) {
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
        </dl>
      </header>

      {model.banner.length > 0 && (
        <div className="app-banner app-banner--notice ana-banner" role="status">
          <strong>Partial report.</strong> {model.banner.join(' ')}
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
        <Card key={s.key} id={`sec-${s.key}`} title={`${s.number}. ${s.title}`}>
          <SectionBody section={s} onCite={onCite} model={model} />
        </Card>
      ))}

      <footer className="ana-footer">{REPORT_FOOTER}</footer>
    </article>
  );
}
