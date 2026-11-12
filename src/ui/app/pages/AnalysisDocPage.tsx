import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { openHarnessDb, type DocumentRecord } from '../../../runner/db';
import { libraryStatusFrom, stageLabel, statusLabel, statusTone } from '../../library/docStatus';
import { isPrepared, readPreparationState, type PreparationState } from '../../library/preparationState';
import { EmptyCard, PageHeader } from './Placeholder';

export function AnalysisDocPage() {
  const { docId } = useParams<{ docId: string }>();
  const [doc, setDoc] = useState<DocumentRecord | null | undefined>(undefined);
  const [prepared, setPrepared] = useState(false);
  const [state, setState] = useState<PreparationState | null>(null);

  useEffect(() => {
    let alive = true;
    if (!docId) {
      setDoc(null);
      return;
    }
    openHarnessDb()
      .then(async (db) => {
        const found = await db.get('documents', docId);
        if (!alive) return;
        setDoc(found ?? null);
        if (found) {
          setPrepared(await isPrepared(db, found));
          setState(readPreparationState(found.id));
        }
      })
      .catch(() => {
        if (alive) setDoc(null);
      });
    return () => {
      alive = false;
    };
  }, [docId]);

  if (doc === undefined) {
    return (
      <>
        <PageHeader eyebrow="Module" title="Deep Analysis" />
        <p className="app-muted">Loading document…</p>
      </>
    );
  }

  if (doc === null) {
    return (
      <>
        <PageHeader
          eyebrow="Module"
          title="Deep Analysis"
          description="This document is not stored on this device."
        />
        <EmptyCard title="Document not on this device">
          <p>
            Import the PDF again on this device to run a new analysis. Reports already saved to Supabase stay available
            after the document is imported and matched by its hash.
          </p>
          <Link className="app-primary-button" to="/documents">
            Go to Documents
          </Link>
        </EmptyCard>
      </>
    );
  }

  const status = libraryStatusFrom({ doc, prepared, state, reviewPages: 0 });
  const label = statusLabel(status, state?.review?.pages ?? 0, state?.stage);
  return (
    <>
      <PageHeader
        eyebrow="Module"
        title={doc.name}
        description={`${doc.pageCount} pages · ${doc.chunkCount} chunks · prepared on this device`}
        actions={<span className={`app-chip app-chip--${statusTone(status)}`}>{label}</span>}
      />
      {prepared ? (
        <EmptyCard title="Deep Analysis is the next build">
          <p>
            This page will run the existing clause analysis, quote verification, roll-up and coverage ledger for this
            document, with a prose answer and an evidence section.
          </p>
          <p className="app-muted">
            The underlying pipeline is already reachable on the dev page:{' '}
            <a href="/?page=analysis">open the analysis pipeline page</a>.
          </p>
        </EmptyCard>
      ) : (
        <EmptyCard title="This document is not ready yet">
          <p>
            {state?.stage === 'failed'
              ? `Preparation failed at ${stageLabel(state.failed?.stage ?? null)}: ${state.failed?.message ?? 'unknown error'}`
              : 'Finish preparation and page review first. Analysis never runs on pages that are still unresolved.'}
          </p>
          <a className="app-primary-button" href={`/?page=ingest&doc=${encodeURIComponent(doc.id)}`}>
            Open preparation page
          </a>
        </EmptyCard>
      )}
      <p className="app-back-link">
        <Link to="/documents">← Back to documents</Link>
      </p>
    </>
  );
}
