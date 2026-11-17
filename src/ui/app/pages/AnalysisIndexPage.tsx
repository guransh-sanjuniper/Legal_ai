import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { openHarnessDb, type DocumentRecord } from '../../../runner/db';
import { isPrepared } from '../../library/preparationState';
import { PageHeader } from './Placeholder';
import { useDeveloperMode } from '../../devMode';

export function AnalysisIndexPage() {
  const [devOn] = useDeveloperMode();
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);

  useEffect(() => {
    let alive = true;
    openHarnessDb()
      .then(async (db) => {
        const all = await db.getAll('documents');
        const prepared: DocumentRecord[] = [];
        for (const doc of all) {
          if (await isPrepared(db, doc)) prepared.push(doc);
        }
        if (!alive) return;
        setDocs(prepared.sort((a, b) => b.createdAt - a.createdAt));
      })
      .catch(() => {
        if (alive) setDocs([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Module"
        title="Deep Analysis"
        description="Clause-by-clause analysis with verified quotes, section summaries, an overview and a coverage ledger."
      />
      {docs === null ? (
        <p className="app-muted">Loading documents…</p>
      ) : docs.length === 0 ? (
        <section className="app-empty-card">
          <span className="app-empty-glyph" aria-hidden="true">
            DA
          </span>
          <h2>No prepared documents yet</h2>
          <div className="app-empty-body">
            <p>Analysis works on a document that has finished preparation and needs no page review.</p>
            <Link className="app-primary-button" to="/documents">
              Go to Documents
            </Link>
          </div>
        </section>
      ) : (
        <ul className="app-doc-list">
          {docs.map((doc) => (
            <li key={doc.id}>
              <Link to={`/analysis/${doc.id}`} className="app-doc-list-item">
                <span className="app-doc-list-name">{doc.name}</span>
                <span className="app-doc-meta">
                  {doc.pageCount} pages{devOn ? ` · ${doc.chunkCount} chunks` : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
