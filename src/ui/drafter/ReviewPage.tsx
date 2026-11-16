import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../app/pages/Placeholder';
import { assemble, draftFileName, exportGate, type DraftBlock, type DraftStats } from '../../drafter/assemble';
import { buildDraftDocx } from '../../drafter/export/docx';
import { getDraft, openDrafterDb, type DrafterDBHandle } from '../../drafter/store';
import type { DraftRecord } from '../../drafter/types';
import './drafter.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withPlaceholders(text: string): ReactNode[] {
  return text.split(/(\[●[^\]]*\])/g).map((part, index) =>
    part.startsWith('[●') ? (
      <mark key={index} className="drafter-doc-mark">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function DocumentView({ blocks }: { blocks: DraftBlock[] }) {
  return (
    <article className="drafter-doc">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'title':
            return (
              <h1 key={index} className="drafter-doc-title">
                {block.text}
              </h1>
            );
          case 'subtitle':
            return (
              <p key={index} className="drafter-doc-subtitle">
                {block.text}
              </p>
            );
          case 'heading': {
            const label = block.number ? `${block.number} ${block.text}` : block.text;
            return block.level === 1 ? (
              <h2 key={index}>{label}</h2>
            ) : (
              <h3 key={index}>{label}</h3>
            );
          }
          case 'paragraph':
            return <p key={index}>{withPlaceholders(block.text)}</p>;
          case 'table':
            return (
              <table key={index} className="drafter-doc-table">
                <thead>
                  <tr>
                    {block.columns.map((column, cellIndex) => (
                      <th key={cellIndex}>{withPlaceholders(column)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {block.columns.map((_, cellIndex) => (
                        <td key={cellIndex}>{withPlaceholders(row[cellIndex] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
        }
      })}
    </article>
  );
}

export function DraftReviewPage() {
  const { draftId } = useParams();

  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!draftId) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      let handle: DrafterDBHandle;
      try {
        handle = await openDrafterDb();
      } catch (e) {
        if (!alive) return;
        setError(`Could not open drafts on this device: ${errorText(e)}`);
        setNotFound(true);
        setLoading(false);
        return;
      }
      if (!alive) return;
      try {
        const found = await getDraft(handle, draftId);
        if (!alive) return;
        if (!found) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        setDraft(found);
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(`Could not open the draft: ${errorText(e)}`);
        setNotFound(true);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [draftId]);

  async function download() {
    if (!draft) return;
    const assembled = assemble(draft);
    const gate = exportGate(assembled.stats);
    if (!gate.allowed) {
      setError(gate.blockers[0] ?? 'The draft is not ready to download.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const blob = await buildDraftDocx(assembled.blocks);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = draftFileName(draft);
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`Could not build the Word document: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader eyebrow="Drafter" title="Review your draft" />
        <p className="app-muted">Loading…</p>
      </>
    );
  }

  if (notFound || !draft) {
    return (
      <>
        <PageHeader eyebrow="Drafter" title="Draft not found" />
        <div className="app-banner app-banner--error" role="alert">
          This draft is not on this device.
        </div>
        <p>
          <Link className="app-link-button" to="/draft">
            Back to drafts
          </Link>
        </p>
      </>
    );
  }

  if (!draft.outline) {
    return (
      <>
        <PageHeader
          eyebrow="Drafter"
          title="Confirm your structure first"
          description="There is nothing to review until the structure is confirmed and written."
        />
        <p>
          <Link className="app-primary-button" to={`/draft/${draft.id}/outline`}>
            Back to structure
          </Link>
        </p>
      </>
    );
  }

  const assembled = assemble(draft);
  const gate = exportGate(assembled.stats);
  const stats: DraftStats = assembled.stats;

  return (
    <>
      <PageHeader
        eyebrow="Drafter"
        title="Review your draft"
        description="Read it through. Download it when it looks right."
      />

      {error && (
        <div className="app-banner app-banner--error" role="alert">
          {error}
        </div>
      )}

      <p className="drafter-outline-summary">
        {stats.sections} section{stats.sections === 1 ? '' : 's'} · {stats.placeholders} detail
        {stats.placeholders === 1 ? '' : 's'} still to fill in · {stats.staleSections} changed since written
      </p>

      {(gate.blockers.length > 0 || gate.warnings.length > 0) && (
        <section className="drafter-review-notices">
          {gate.blockers.length > 0 && (
            <ul className="drafter-notes">
              {gate.blockers.map((blocker) => (
                <li key={blocker} className="drafter-note">
                  {blocker}
                </li>
              ))}
            </ul>
          )}
          {gate.warnings.length > 0 && (
            <ul className="drafter-review-warnings">
              {gate.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="drafter-actions drafter-review-actions">
        <div className="drafter-primary-stack">
          <button
            type="button"
            className="app-primary-button"
            disabled={!gate.allowed || busy}
            onClick={() => void download()}
          >
            {busy ? 'Preparing…' : 'Download Word document'}
          </button>
          {!gate.allowed && (
            <span className="app-muted drafter-next-note">{gate.blockers[0] ?? 'The draft is not ready yet.'}</span>
          )}
        </div>
        <div className="drafter-secondary-actions">
          <Link className="app-link-button" to={`/draft/${draft.id}/write`}>
            Back to writing
          </Link>
        </div>
      </div>

      <DocumentView blocks={assembled.blocks} />
    </>
  );
}
