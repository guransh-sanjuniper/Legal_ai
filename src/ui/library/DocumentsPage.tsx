import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  openHarnessDb,
  type DocumentRecord,
  type HarnessDBHandle,
} from '../../runner/db';
import { requestPersistence, storageReport, type StorageReport } from '../../ingest/storage';
import { libraryStatusFrom, needsResumeAfterReview, readyLabel, stageLabel, statusLabel, statusTone } from './docStatus';
import { countReviewPages, isPrepared, readPreparationState, type PreparationState } from './preparationState';
import { countWaivedPages, waiveUnresolvedPages } from '../../ingest/review';
import { getActiveDocId, runPreparation, subscribePreparation } from './prepare';
import { documentLock, removeDocumentWhenIdle } from './removeDocument';
import { PageHeader } from '../app/pages/Placeholder';
import {
  clearFinishedImports,
  enqueueFiles,
  getImportEntries,
  removeImportEntry,
  retryImportEntry,
  subscribeImportNotice,
  subscribeImportQueue,
} from './importQueueInstance';
import type { QueueEntry } from './importQueue';
import { conversionNote, readConversionMeta } from './conversionMeta';
import { formatFileSize } from './convert/detect';
import './library.css';

const LANG_OPTIONS = ['eng', 'eng+mar', 'eng+hin', 'eng+mar+hin'];
const FILE_ACCEPT =
  '.pdf,.docx,.txt,.md,.markdown,.png,.jpg,.jpeg,.doc,.rtf,.xls,.xlsx,.ppt,.pptx,' +
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'text/plain,text/markdown,image/png,image/jpeg';

function queueStatusText(entry: QueueEntry): string {
  switch (entry.status) {
    case 'waiting':
      return 'Waiting';
    case 'converting':
      return 'Converting to PDF';
    case 'preparing':
      return 'Preparing';
    case 'ready':
      return 'Ready';
    case 'needs_review':
      return entry.reviewPages && entry.reviewPages > 0
        ? `Needs review (${entry.reviewPages} page${entry.reviewPages === 1 ? '' : 's'})`
        : 'Needs review';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return entry.duplicate ? 'Already on this device' : 'Not supported';
    default:
      return '';
  }
}

function queueStatusTone(entry: QueueEntry): 'neutral' | 'warn' | 'ok' | 'danger' {
  if (entry.status === 'failed') return 'danger';
  if (entry.status === 'needs_review') return 'warn';
  if (entry.status === 'ready') return 'ok';
  if (entry.status === 'skipped') return entry.duplicate ? 'neutral' : 'warn';
  return 'neutral';
}

function queueSummary(entries: QueueEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key =
      entry.status === 'skipped'
        ? entry.duplicate
          ? 'already on this device'
          : 'not supported'
        : entry.status === 'needs_review'
          ? 'needs review'
          : entry.status;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const order = ['preparing', 'converting', 'waiting', 'ready', 'needs review', 'failed', 'already on this device', 'not supported'];
  const parts = [...counts.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([label, count]) => `${count} ${label}`);
  return `${entries.length} file${entries.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

function maxFileLabel(): string {
  const raw = Number(import.meta.env.VITE_LIBRARY_MAX_FILE_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 50;
  return `${mb} MB`;
}

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
  const [waivedCounts, setWaivedCounts] = useState<Record<string, number>>({});
  const [prepStates, setPrepStates] = useState<Record<string, PreparationState | null>>({});
  const [preparedIds, setPreparedIds] = useState<Record<string, boolean>>({});
  const [activeState, setActiveState] = useState<PreparationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>(() => getImportEntries());
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [ocrLangs, setOcrLangs] = useState('eng');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const reviewCacheRef = useRef(new Map<string, number>());
  const reviewSigRef = useRef(new Map<string, string>());
  const waivedCacheRef = useRef(new Map<string, number>());
  const waivedSigRef = useRef(new Map<string, string>());
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
      const waived: Record<string, number> = {};
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

        // Waived pages only matter for documents that can be Ready.
        if (doc.status !== 'ready') {
          waived[doc.id] = 0;
        } else {
          const signature = `${doc.status}|${doc.prepFingerprint}|${doc.chunkCount}`;
          const cached = waivedCacheRef.current.get(doc.id);
          if (cached !== undefined && waivedSigRef.current.get(doc.id) === signature) {
            waived[doc.id] = cached;
          } else {
            const count = await countWaivedPages(target, doc.id);
            waivedCacheRef.current.set(doc.id, count);
            waivedSigRef.current.set(doc.id, signature);
            waived[doc.id] = count;
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
      setWaivedCounts(waived);
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

  // The import queue also lives outside React; this keeps its panel live and refreshes
  // the document table when a queued file reaches a terminal state.
  useEffect(() => subscribeImportQueue(setQueueEntries), []);
  useEffect(() => subscribeImportNotice(setQueueNotice), []);
  useEffect(() => {
    if (
      queueEntries.some(
        (entry) =>
          entry.status === 'converting' ||
          entry.status === 'preparing' ||
          entry.status === 'ready' ||
          entry.status === 'needs_review' ||
          entry.status === 'failed',
      )
    ) {
      void refresh();
      void storageReport(0)
        .then(setStorage)
        .catch(() => undefined);
    }
  }, [queueEntries, refresh]);

  // Review counts can change from the harness page in another tab.
  useEffect(() => {
    const onFocus = () => {
      reviewSigRef.current.clear();
      waivedSigRef.current.clear();
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

  // Auto-resume the first document that stopped mid-preparation. A review document waits
  // for the user unless nothing is left to review (Proceed was chosen and the tab closed
  // before finalize). A failed document waits too: Retry is explicit.
  useEffect(() => {
    if (!db || loading || resumeAttemptRef.current) return;
    if (getActiveDocId()) return;
    if (
      queueEntries.some(
        (entry) =>
          entry.status === 'waiting' || entry.status === 'converting' || entry.status === 'preparing',
      )
    ) {
      return;
    }
    const first = docs.find((doc) => {
      if (preparedIds[doc.id]) return false;
      if (doc.status === 'review' && !needsResumeAfterReview(doc.status, reviewCounts[doc.id] ?? 0)) return false;
      const state = prepStates[doc.id];
      if (state?.stage === 'failed') return false;
      return true;
    });
    if (!first) return;
    resumeAttemptRef.current = true;
    runFor(first);
  }, [db, loading, docs, preparedIds, prepStates, reviewCounts, queueEntries, runFor]);

  function enqueue(files: File[]) {
    if (!db || files.length === 0) return;
    setError(null);
    setNotice(null);
    enqueueFiles(files, { db, ocrLangs });
  }

  function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length > 0) enqueue(files);
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave() {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    enqueue(Array.from(event.dataTransfer.files));
  }

  function openDoc(doc: DocumentRecord) {
    if (preparedIds[doc.id]) navigate(`/analysis/${doc.id}`);
    else if (doc.status === 'review') openReview(doc);
    else if (!busyDocId) runFor(doc);
  }

  function openReview(doc: DocumentRecord) {
    navigate(`/documents/${encodeURIComponent(doc.id)}/review`);
  }

  async function proceedWithoutReview(doc: DocumentRecord) {
    if (!db) return;
    const pending = reviewCounts[doc.id] ?? 0;
    const confirmed = window.confirm(
      `Proceed without reviewing "${doc.name}"?\n\n${pending} page(s) need a decision. ` +
        'OCR text will be used as extracted; unreviewed pages may contain errors.',
    );
    if (!confirmed) return;
    setError(null);
    const waived = await waiveUnresolvedPages(db, doc.id);
    setNotice(`${waived} page(s) proceed with their OCR text as extracted. Preparing "${doc.name}".`);
    runFor(doc, { forceIngest: true });
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
      waivedCacheRef.current.delete(doc.id);
      waivedSigRef.current.delete(doc.id);
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
    <div
      className={`library-page${dragging ? ' library-page--dragging' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="library-drop-overlay" aria-hidden="true">
          <span>Drop files to import</span>
        </div>
      )}

      <PageHeader
        eyebrow="Library"
        title="Documents"
        description="PDFs, Word files, text and images are prepared once on this device, then used by every module. They are never uploaded to Supabase."
        actions={
          <>
            <label className="app-select-label">
              <span>OCR language</span>
              <select value={ocrLangs} onChange={(e) => setOcrLangs(e.target.value)}>
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
              multiple
              accept={FILE_ACCEPT}
              className="app-hidden-input"
              onChange={onFileInput}
            />
            <button
              type="button"
              className="app-primary-button"
              disabled={!db}
              onClick={() => fileInputRef.current?.click()}
            >
              Import documents
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
      <p className="library-format-hint">
        PDF, Word (.docx), text (.txt or .md) and image (.png or .jpg) files. Files are converted to PDF before
        preparation; page numbers refer to the converted version. Up to {maxFileLabel()} per converted file.
      </p>

      {error && (
        <div className="app-banner app-banner--error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="app-banner app-banner--notice">{notice}</div>}
      {queueNotice && <div className="app-banner app-banner--notice">{queueNotice}</div>}

      {queueEntries.length > 0 && (
        <section className="library-queue" aria-label="Import queue">
          <div className="library-queue-head">
            <div>
              <h2>Import queue</h2>
              <p className="app-muted" role="status">
                {queueSummary(queueEntries)}
              </p>
            </div>
            {queueEntries.some(
              (entry) =>
                entry.status === 'ready' || entry.status === 'needs_review' || entry.status === 'skipped',
            ) && (
              <button type="button" className="app-link-button" onClick={clearFinishedImports}>
                Clear finished
              </button>
            )}
          </div>
          <ul className="library-queue-list">
            {queueEntries.map((entry) => (
              <li key={entry.id} className="library-queue-row">
                <div className="library-queue-main">
                  <div className="library-queue-title">
                    <span>{entry.fileName}</span>
                    <span className={`app-chip app-chip--${queueStatusTone(entry)}`}>
                      {queueStatusText(entry)}
                    </span>
                  </div>
                  <span className="library-queue-meta">
                    {formatBytes(entry.size)}
                    {entry.conversionLabel ? ` · Converted from ${entry.conversionLabel}` : ''}
                  </span>
                  {(entry.status === 'converting' || entry.status === 'preparing') && (
                    <div
                      className="app-progress app-progress--indeterminate"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={0}
                      aria-valuenow={0}
                    >
                      <div className="app-progress-bar app-progress-bar--indeterminate" />
                    </div>
                  )}
                  {entry.message && (
                    <span
                      className={`library-queue-message${
                        entry.status === 'failed' ? ' library-queue-message--danger' : ''
                      }`}
                    >
                      {entry.message}
                    </span>
                  )}
                  {entry.warnings.map((warning, index) => (
                    <span key={`${entry.id}-warning-${index}`} className="library-queue-warn">
                      {warning}
                    </span>
                  ))}
                </div>
                <div className="library-queue-actions">
                  {entry.status === 'ready' && entry.docId && (
                    <button
                      type="button"
                      className="app-link-button"
                      onClick={() => navigate(`/analysis/${encodeURIComponent(entry.docId!)}`)}
                    >
                      Open
                    </button>
                  )}
                  {entry.status === 'needs_review' && entry.docId && (
                    <button
                      type="button"
                      className="app-link-button"
                      onClick={() => navigate(`/documents/${encodeURIComponent(entry.docId!)}/review`)}
                    >
                      Review
                    </button>
                  )}
                  {entry.status === 'failed' && entry.retryable && (
                    <button
                      type="button"
                      className="app-link-button"
                      onClick={() => retryImportEntry(entry.id)}
                    >
                      Retry
                    </button>
                  )}
                  {entry.status === 'waiting' && (
                    <button
                      type="button"
                      className="app-link-button app-link-button--danger"
                      onClick={() => removeImportEntry(entry.id)}
                    >
                      Remove from queue
                    </button>
                  )}
                  {entry.status === 'skipped' && (
                    <button
                      type="button"
                      className="app-link-button"
                      onClick={() => removeImportEntry(entry.id)}
                    >
                      Dismiss
                    </button>
                  )}
                  {entry.status === 'failed' && (
                    <button
                      type="button"
                      className="app-link-button"
                      onClick={() => removeImportEntry(entry.id)}
                    >
                      {entry.docId ? 'Dismiss' : 'Remove from queue'}
                    </button>
                  )}
                  {(entry.status === 'ready' || entry.status === 'needs_review') && (
                    <button
                      type="button"
                      className="app-link-button"
                      onClick={() => removeImportEntry(entry.id)}
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="library-queue-note">
            Waiting files are not kept if you close or reload this tab. A file that is already preparing resumes from
            the library.
          </p>
        </section>
      )}

      {loading ? (
        <p className="app-muted">Loading documents…</p>
      ) : docs.length === 0 ? (
        <section className="app-empty-card">
          <span className="app-empty-glyph" aria-hidden="true">
            PDF
          </span>
          <h2>No documents on this device</h2>
          <div className="app-empty-body">
            <p>
              Import a PDF, Word file, text file or image to extract its pages, run OCR where needed and prepare it for
              analysis.
            </p>
            <p className="app-muted">
              Word, text and image files are converted to PDF on this device first. Preparation happens in this browser.
              A scanned document will show “Needs review” with the pages that need a decision.
            </p>
            <button
              type="button"
              className="app-primary-button"
              disabled={!db}
              onClick={() => fileInputRef.current?.click()}
            >
              Import documents
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
                const waivedPages = waivedCounts[doc.id] ?? 0;
                const current = state?.progress;
                const statusText =
                  status === 'preparing' && current && current.total > 0
                    ? `${label} ${current.done}/${current.total}`
                    : status === 'ready'
                      ? readyLabel(waivedPages)
                      : label;
                const indeterminate = status === 'preparing' && (!current || current.total === 0);
                const failed = state?.failed;
                const conversion = readConversionMeta(doc.id);
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
                      {conversion && (
                        <span
                          className="library-converted-note"
                          title={
                            `${conversionNote(conversion)}. Page numbers refer to the converted version. ` +
                            'Headers, footers, pictures and tracked changes may not be included.'
                          }
                        >
                          {conversionNote(conversion)} · Page numbers refer to the converted version.
                        </span>
                      )}
                      {conversion && conversion.warnings.length > 0 && (
                        <span className="library-row-warn" title={conversion.warnings.join('\n')}>
                          {conversion.warnings[0]}
                          {conversion.warnings.length > 1 ? ` (+${conversion.warnings.length - 1} more)` : ''}
                        </span>
                      )}
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
                      <span
                        className={`app-chip app-chip--${statusTone(status)}`}
                        title={
                          status === 'ready' && waivedPages > 0
                            ? `${waivedPages} page(s) were accepted with their OCR text as extracted, not reviewed by a person.`
                            : undefined
                        }
                      >
                        {statusText}
                      </span>
                    </td>
                    <td>
                      <div className="app-row-actions">
                        <button type="button" className="app-link-button" onClick={() => openDoc(doc)}>
                          {status === 'ready' ? 'Open' : status === 'needs_review' ? 'Review' : 'Prepare'}
                        </button>
                        {status === 'ready' && waivedPages > 0 && (
                          <button type="button" className="app-link-button" onClick={() => openReview(doc)}>
                            Review
                          </button>
                        )}
                        {status === 'needs_review' && (
                          <button
                            type="button"
                            className="app-link-button"
                            disabled={Boolean(busyDocId)}
                            onClick={() => void proceedWithoutReview(doc)}
                          >
                            Proceed without reviewing
                          </button>
                        )}
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
    </div>
  );
}
