import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  openHarnessDb,
  type DocumentRecord,
  type HarnessDBHandle,
} from '../../runner/db';
import { sha256Bytes } from '../../ingest/hash';
import { requestPersistence, storageReport, type StorageReport } from '../../ingest/storage';
import { libraryStatusFrom, stageLabel, statusLabel, statusTone } from './docStatus';
import { countReviewPages, isPrepared, readPreparationState, type PreparationState } from './preparationState';
import { getActiveDocId, runPreparation, subscribePreparation } from './prepare';
import { documentLock, removeDocumentWhenIdle } from './removeDocument';
import { PageHeader } from '../app/pages/Placeholder';

const LANG_OPTIONS = ['eng', 'eng+mar', 'eng+hin', 'eng+mar+hin'];

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

interface PreparedCacheEntry {
  key: string;
  prepared: boolean;
}

export function DocumentsPage() {
  const navigate = useNavigate();
  const [db, setDb] = useState<HarnessDBHandle | null>(null);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [reviewCounts, setReviewCounts] = useState<Record<string, number>>({});
  const [prepStates, setPrepStates] = useState<Record<string, PreparationState | null>>({});
  const [preparedIds, setPreparedIds] = useState<Record<string, boolean>>({});
  const [activeState, setActiveState] = useState<PreparationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [ocrLangs, setOcrLangs] = useState('eng');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const reviewCacheRef = useRef(new Map<string, number>());
  const reviewSigRef = useRef(new Map<string, string>());
  const preparedCacheRef = useRef(new Map<string, PreparedCacheEntry>());
  const resumeAttemptRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    openHarnessDb()
      .then(async (handle) => {
        if (cancelled) return;
        setDb(handle);
        const [isPersisted, report] = await Promise.all([requestPersistence(), storageReport(0)]);
        if (cancelled) return;
        setPersisted(isPersisted);
        setStorage(report);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`Could not open local storage: ${String(e)}`);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(
    async (handle?: HarnessDBHandle | null) => {
      const target = handle ?? db;
      if (!target) return;
      const all = (await target.getAll('documents')).sort((a, b) => b.createdAt - a.createdAt);
      setDocs(all);

      const counts: Record<string, number> = {};
      const states: Record<string, PreparationState | null> = {};
      const prepared: Record<string, boolean> = {};

      for (const doc of all) {
        states[doc.id] = readPreparationState(doc.id);

        if (doc.status !== 'review') {
          counts[doc.id] = 0;
        } else {
          const signature = `${doc.status}|${doc.pageCount}|${doc.chunkCount}`;
          const cached = reviewCacheRef.current.get(doc.id);
          if (cached !== undefined && reviewSigRef.current.get(doc.id) === signature) {
            counts[doc.id] = cached;
          } else {
            const count = await countReviewPages(target, doc.id);
            reviewCacheRef.current.set(doc.id, count);
            reviewSigRef.current.set(doc.id, signature);
            counts[doc.id] = count;
          }
        }

        const key = `${doc.status}|${doc.prepFingerprint}|${doc.chunkCount}`;
        const cached = preparedCacheRef.current.get(doc.id);
        if (cached && cached.key === key) {
          prepared[doc.id] = cached.prepared;
        } else {
          const value = await isPrepared(target, doc);
          preparedCacheRef.current.set(doc.id, { key, prepared: value });
          prepared[doc.id] = value;
        }
      }

      setReviewCounts(counts);
      setPrepStates(states);
      setPreparedIds(prepared);
      setBusyDocId(getActiveDocId());
      setLoading(false);
    },
    [db],
  );

  useEffect(() => {
    if (!db) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [db, refresh]);

  // The orchestrator runs outside React, so a preparation started on another route
  // keeps its state and progress. This subscription keeps the table live.
  useEffect(() => {
    return subscribePreparation((state) => {
      setActiveState(state);
      setBusyDocId(getActiveDocId());
      preparedCacheRef.current.delete(state.docId);
      if (state.stage === 'ready' || state.stage === 'failed' || state.stage === 'needs-review') {
        void refresh();
      }
    });
  }, [refresh]);

  // Review counts can change from the harness page in another tab.
  useEffect(() => {
    const onFocus = () => {
      reviewSigRef.current.clear();
      preparedCacheRef.current.clear();
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const runFor = useCallback(
    (doc: DocumentRecord, force: { forceIngest?: boolean; forceDefinitions?: boolean } = {}) => {
      if (!db) return;
      setError(null);
      setNotice(null);
      setBusyDocId(doc.id);
      void runPreparation(doc.id, { db, ...force })
        .catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          setBusyDocId(getActiveDocId());
          void refresh();
        });
    },
    [db, refresh],
  );

  // Auto-resume the first document that stopped mid-preparation. A review or failed
  // document waits for the user: the review page is a decision, and Retry is explicit.
  useEffect(() => {
    if (!db || loading || resumeAttemptRef.current) return;
    if (getActiveDocId()) return;
    const first = docs.find((doc) => {
      if (preparedIds[doc.id]) return false;
      if (doc.status === 'review') return false;
      const state = prepStates[doc.id];
      if (state?.stage === 'failed') return false;
      return true;
    });
    if (!first) return;
    resumeAttemptRef.current = true;
    runFor(first);
  }, [db, loading, docs, preparedIds, prepStates, runFor]);

  async function onFile(file: File) {
    if (!db || importing) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const report = await storageReport(file.size);
      setStorage(report);
      if (!report.fits) {
        setNotice(
          `Quota warning: this file needs about ${formatBytes(report.neededBytes)} free, but only ${formatBytes(
            report.free,
          )} is available. Importing may fail.`,
        );
      }
      setPersisted(await requestPersistence());

      const buffer = await file.arrayBuffer();
      const hash = await sha256Bytes(buffer);
      const existing = await db.get('documents', hash);
      if (existing) {
        setNotice(`${file.name} is already on this device.`);
        await refresh();
        return;
      }

      const doc: DocumentRecord = {
        id: hash,
        name: file.name,
        hash,
        size: file.size,
        pdf: new Blob([buffer], { type: 'application/pdf' }),
        createdAt: Date.now(),
        status: 'new',
        ocrLangs,
        pageCount: 0,
        prepFingerprint: null,
        chunkCount: 0,
      };
      await db.put('documents', doc);
      await refresh();
      runFor(doc);
    } catch (e) {
      setError(`Could not import the PDF: ${String(e)}`);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function openDoc(doc: DocumentRecord) {
    if (preparedIds[doc.id]) navigate(`/analysis/${doc.id}`);
    else window.location.assign(`/?page=ingest&doc=${encodeURIComponent(doc.id)}`);
  }

  async function removeDoc(doc: DocumentRecord) {
    if (!db) return;
    const lock = await documentLock(doc);
    if (lock) {
      setError('This document is being prepared or analysed. Wait for it to finish before removing it.');
      return;
    }
    const confirmed = window.confirm(
      `Remove "${doc.name}" from this device?\n\nThe PDF, pages, chunks, embeddings and local run state will be deleted. ` +
        'Reports already saved to Supabase are kept.',
    );
    if (!confirmed) return;
    setRemovingId(doc.id);
    setError(null);
    try {
      const removed = await removeDocumentWhenIdle(db, doc);
      if (!removed) {
        setError('This document is being prepared or analysed. Wait for it to finish before removing it.');
        return;
      }
      reviewCacheRef.current.delete(doc.id);
      reviewSigRef.current.delete(doc.id);
      preparedCacheRef.current.delete(doc.id);
      await refresh();
      setNotice(`Removed "${doc.name}" from this device.`);
    } catch (e) {
      setError(`Could not remove the document: ${String(e)}`);
    } finally {
      setRemovingId(null);
    }
  }

  const storageLine =
    storage && storage.quota > 0
      ? `Local storage: ${formatBytes(storage.usage)} used of ${formatBytes(storage.quota)}.`
      : null;

  return (
    <>
      <PageHeader
        eyebrow="Library"
        title="Documents"
        description="PDFs are prepared once on this device, then used by every module. They are never uploaded to Supabase."
        actions={
          <>
            <label className="app-select-label">
              <span>OCR language</span>
              <select value={ocrLangs} onChange={(e) => setOcrLangs(e.target.value)} disabled={importing}>
                {LANG_OPTIONS.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="app-hidden-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
            <button
              type="button"
              className="app-primary-button"
              disabled={!db || importing || Boolean(busyDocId)}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? 'Importing…' : 'Import PDF'}
            </button>
          </>
        }
      />

      <div className="app-storage-line">
        {storageLine}
        {persisted === false && (
          <span className="app-storage-warn">
            Storage is not persistent: the browser may clear documents. Remove unused documents to free space.
          </span>
        )}
        {persisted === true && <span className="app-muted">Storage is protected on this device.</span>}
      </div>

      {error && (
        <div className="app-banner app-banner--error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="app-banner app-banner--notice">{notice}</div>}

      {loading ? (
        <p className="app-muted">Loading documents…</p>
      ) : docs.length === 0 ? (
        <section className="app-empty-card">
          <span className="app-empty-glyph" aria-hidden="true">
            PDF
          </span>
          <h2>No documents on this device</h2>
          <div className="app-empty-body">
            <p>Import a PDF to extract its pages, run OCR where needed and prepare it for analysis.</p>
            <p className="app-muted">
              Preparation happens in this browser. A scanned document will show “Needs review” with the pages that need a
              decision.
            </p>
            <button
              type="button"
              className="app-primary-button"
              disabled={!db || importing || Boolean(busyDocId)}
              onClick={() => fileInputRef.current?.click()}
            >
              Import PDF
            </button>
          </div>
        </section>
      ) : (
        <div className="app-table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Pages</th>
                <th scope="col">Size</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="app-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => {
                const state = activeState?.docId === doc.id ? activeState : prepStates[doc.id] ?? null;
                const status = libraryStatusFrom({
                  doc,
                  prepared: preparedIds[doc.id] ?? false,
                  state,
                  reviewPages: reviewCounts[doc.id] ?? 0,
                });
                const label = statusLabel(status, reviewCounts[doc.id] ?? 0, state?.stage);
                const current = state?.progress;
                const statusText =
                  status === 'preparing' && current && current.total > 0 ? `${label} ${current.done}/${current.total}` : label;
                const indeterminate = status === 'preparing' && (!current || current.total === 0);
                const failed = state?.failed;
                return (
                  <tr key={doc.id}>
                    <td>
                      <button type="button" className="app-doc-name" onClick={() => openDoc(doc)}>
                        {doc.name}
                      </button>
                      <span className="app-doc-meta">
                        Added {formatDate(doc.createdAt)}
                        {doc.chunkCount > 0 ? ` · ${doc.chunkCount} chunks` : ''}
                        {status === 'ready' && state?.preparedAt ? ` · Prepared ${formatDate(state.preparedAt)}` : ''}
                      </span>
                      {status === 'preparing' && state?.message && (
                        <span className="app-stage-label">{state.message}</span>
                      )}
                      {status === 'failed' && failed && (
                        <span className="app-row-error">
                          {stageLabel(failed.stage)}: {failed.message}
                        </span>
                      )}
                      {status === 'preparing' && (
                        <div
                          className={`app-progress${indeterminate ? ' app-progress--indeterminate' : ''}`}
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={current?.total ?? 0}
                          aria-valuenow={current?.done ?? 0}
                        >
                          <div
                            className={`app-progress-bar${indeterminate ? ' app-progress-bar--indeterminate' : ''}`}
                            style={
                              indeterminate
                                ? undefined
                                : { width: `${current && current.total > 0 ? Math.round((current.done / current.total) * 100) : 0}%` }
                            }
                          />
                        </div>
                      )}
                    </td>
                    <td>{doc.pageCount > 0 ? doc.pageCount : '—'}</td>
                    <td>{formatBytes(doc.size)}</td>
                    <td>
                      <span className={`app-chip app-chip--${statusTone(status)}`}>{statusText}</span>
                    </td>
                    <td>
                      <div className="app-row-actions">
                        <button type="button" className="app-link-button" onClick={() => openDoc(doc)}>
                          {status === 'ready' ? 'Open' : status === 'needs_review' ? 'Review' : 'Prepare'}
                        </button>
                        {status === 'preparing' && (
                          <button
                            type="button"
                            className="app-link-button"
                            disabled={Boolean(busyDocId)}
                            onClick={() => runFor(doc)}
                          >
                            Resume
                          </button>
                        )}
                        {status === 'failed' && (
                          <button
                            type="button"
                            className="app-link-button"
                            disabled={Boolean(busyDocId)}
                            onClick={() =>
                              runFor(doc, {
                                forceIngest: failed?.stage === 'ingest',
                                forceDefinitions: failed?.stage === 'definitions',
                              })
                            }
                          >
                            Retry
                          </button>
                        )}
                        <button
                          type="button"
                          className="app-link-button app-link-button--danger"
                          disabled={removingId === doc.id || busyDocId === doc.id}
                          onClick={() => void removeDoc(doc)}
                        >
                          {removingId === doc.id ? 'Removing…' : 'Remove'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
