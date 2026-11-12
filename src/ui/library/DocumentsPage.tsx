import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  openHarnessDb,
  FINAL_PAGE_STATUSES,
  type DocumentRecord,
  type HarnessDBHandle,
} from '../../runner/db';
import { sha256Bytes } from '../../ingest/hash';
import { requestPersistence, storageReport, type StorageReport } from '../../ingest/storage';
import { libraryStatus, statusLabel, statusTone } from './docStatus';
import { startIngestWorker, type IngestHandle } from './ingestRunner';
import { documentLock, removeDocumentFromDevice } from './removeDocument';
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

// Counts pages that still need a decision. Only used for the "Needs review (N)" label.
async function countReviewPages(db: HarnessDBHandle, docId: string): Promise<number> {
  let count = 0;
  let cursor = await db
    .transaction('pages')
    .store.openCursor(IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]));
  while (cursor) {
    if (!FINAL_PAGE_STATUSES.includes(cursor.value.status)) count++;
    cursor = await cursor.continue();
  }
  return count;
}

export function DocumentsPage() {
  const navigate = useNavigate();
  const [db, setDb] = useState<HarnessDBHandle | null>(null);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [reviewCounts, setReviewCounts] = useState<Record<string, number>>({});
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({});
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
  const runnerRef = useRef<IngestHandle | null>(null);
  const reviewCacheRef = useRef(new Map<string, number>());
  const reviewSigRef = useRef(new Map<string, string>());

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
      for (const doc of all) {
        if (doc.status !== 'review') {
          counts[doc.id] = 0;
          continue;
        }
        const signature = `${doc.status}|${doc.pageCount}|${doc.chunkCount}`;
        const cached = reviewCacheRef.current.get(doc.id);
        if (cached !== undefined && reviewSigRef.current.get(doc.id) === signature) {
          counts[doc.id] = cached;
          continue;
        }
        const count = await countReviewPages(target, doc.id);
        reviewCacheRef.current.set(doc.id, count);
        reviewSigRef.current.set(doc.id, signature);
        counts[doc.id] = count;
      }
      setReviewCounts(counts);
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

  // Review counts can change from the harness page in another tab.
  useEffect(() => {
    const onFocus = () => {
      reviewSigRef.current.clear();
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // The preparation worker is intentionally not terminated on unmount: it lives outside
  // the page so navigating to another module does not stop an import. Its own Web Lock
  // still prevents a second worker for the same document.

  function clearProgress(docId: string) {
    setProgress((current) => {
      const next = { ...current };
      delete next[docId];
      return next;
    });
  }

  function startFor(docId: string) {
    if (runnerRef.current) {
      setError('Another document is being prepared in this tab. Wait for it to finish first.');
      return;
    }
    setError(null);
    setNotice(null);
    setBusyDocId(docId);
    setProgress((current) => ({ ...current, [docId]: { done: 0, total: 0 } }));

    runnerRef.current = startIngestWorker(docId, (event) => {
      switch (event.type) {
        case 'progress':
          setProgress((current) => ({ ...current, [docId]: { done: event.done, total: event.total } }));
          break;
        case 'finished':
          reviewSigRef.current.delete(docId);
          void refresh();
          break;
        case 'locked':
          setError('This document is already being prepared in another tab.');
          setBusyDocId(null);
          clearProgress(docId);
          runnerRef.current = null;
          break;
        case 'error':
          setError(`Preparation failed: ${event.message}`);
          setBusyDocId(null);
          clearProgress(docId);
          runnerRef.current = null;
          break;
        case 'idle':
          setBusyDocId(null);
          clearProgress(docId);
          runnerRef.current = null;
          reviewSigRef.current.delete(docId);
          void refresh();
          break;
        default:
          break;
      }
    });
  }

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

      await db.put('documents', {
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
      });
      await refresh();
      startFor(hash);
    } catch (e) {
      setError(`Could not import the PDF: ${String(e)}`);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function openDoc(doc: DocumentRecord) {
    if (doc.status === 'ready') navigate(`/analysis/${doc.id}`);
    else window.location.assign(`/?page=ingest&doc=${encodeURIComponent(doc.id)}`);
  }

  async function removeDoc(doc: DocumentRecord) {
    if (!db) return;
    const lock = await documentLock(doc);
    if (lock) {
      setError(
        `This document is being ${lock === 'preparation' ? 'prepared' : 'analysed'}. Wait for it to finish before removing it.`,
      );
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
      await removeDocumentFromDevice(db, doc);
      reviewCacheRef.current.delete(doc.id);
      reviewSigRef.current.delete(doc.id);
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
                const status = libraryStatus(doc.status);
                const reviewPages = reviewCounts[doc.id] ?? 0;
                const label = statusLabel(status, reviewPages);
                const current = progress[doc.id];
                const statusText =
                  status === 'preparing' && current && current.total > 0 ? `${label} ${current.done}/${current.total}` : label;
                return (
                  <tr key={doc.id}>
                    <td>
                      <button type="button" className="app-doc-name" onClick={() => openDoc(doc)}>
                        {doc.name}
                      </button>
                      <span className="app-doc-meta">
                        Added {formatDate(doc.createdAt)}
                        {doc.chunkCount > 0 ? ` · ${doc.chunkCount} chunks` : ''}
                      </span>
                    </td>
                    <td>{doc.pageCount > 0 ? doc.pageCount : '—'}</td>
                    <td>{formatBytes(doc.size)}</td>
                    <td>
                      <span className={`app-chip app-chip--${statusTone(status)}`}>{statusText}</span>
                    </td>
                    <td>
                      <div className="app-row-actions">
                        <button type="button" className="app-link-button" onClick={() => openDoc(doc)}>
                          {doc.status === 'ready' ? 'Open' : 'Review'}
                        </button>
                        {doc.status !== 'ready' && (
                          <button
                            type="button"
                            className="app-link-button"
                            disabled={Boolean(busyDocId)}
                            onClick={() => startFor(doc.id)}
                          >
                            Resume
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
