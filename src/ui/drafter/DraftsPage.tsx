import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../app/AuthProvider';
import { PageHeader } from '../app/pages/Placeholder';
import { pickWhenToUse } from '../help/helpContent';
import { draftStatusText } from './statusLabel';
import { listDrafts, openDrafterDb, type DrafterDBHandle } from '../../drafter/store';
import { removeDraftEverywhere, syncDrafts } from '../../drafter/sync';
import type { DraftRecord, DraftStatus } from '../../drafter/types';
import './drafter.css';

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusTone(status: DraftStatus): 'ok' | 'warn' | 'neutral' | 'danger' {
  if (status === 'done') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'generating') return 'warn';
  return 'neutral';
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function DraftsPage() {
  const { session } = useAuth();
  const userId = session?.user.id ?? '';

  const [db, setDb] = useState<DrafterDBHandle | null>(null);
  const [drafts, setDrafts] = useState<DraftRecord[] | null>(null);
  const [pendingSync, setPendingSync] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refresh = useCallback(
    async (handle: DrafterDBHandle) => {
      const list = await listDrafts(handle, userId);
      setDrafts(list);
      setPendingSync(list.some((draft) => draft.syncedAt !== draft.updatedAt));
      return list;
    },
    [userId],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const handle = await openDrafterDb();
        if (!alive) return;
        setDb(handle);
        // Local first: the list is drawn before the network is touched.
        await refresh(handle);
        const result = await syncDrafts(supabase, handle, userId);
        if (!alive) return;
        if (result.pulled > 0 || result.pushed > 0 || result.deleted > 0) await refresh(handle);
      } catch (e) {
        if (!alive) return;
        setError(`Could not open drafts on this device: ${errorText(e)}`);
        setDrafts([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId, refresh]);

  async function remove(draft: DraftRecord) {
    if (!db) return;
    const confirmed = window.confirm(
      `Delete "${draft.title}"?\n\nThe draft is removed from this device and from your saved drafts.`,
    );
    if (!confirmed) return;
    setDeletingId(draft.id);
    setError(null);
    try {
      const removed = await removeDraftEverywhere(supabase, db, draft.id);
      if (!removed) {
        setError('Could not delete the draft from this device.');
        return;
      }
      await refresh(db);
    } catch (e) {
      setError(`Could not delete the draft: ${errorText(e)}`);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Module"
        title="Drafter"
        whenToUse={pickWhenToUse(
          'Describe the document you need in your own words, optionally pointing at prepared documents. The brief is saved on this device and in your account.',
          'drafter',
        )}
        helpHref="/help#drafter"
        actions={
          <Link className="app-primary-button" to="/draft/new">
            New draft
          </Link>
        }
      />

      {error && (
        <div className="app-banner app-banner--error" role="alert">
          {error}
        </div>
      )}
      {pendingSync && (
        <p className="drafter-sync-note">
          Some drafts are saved on this device only. Cloud sync will retry on the next save or page load.
        </p>
      )}

      {drafts === null ? (
        <p className="app-muted">Loading drafts…</p>
      ) : drafts.length === 0 ? (
        <section className="app-empty-card">
          <span className="app-empty-glyph" aria-hidden="true">
            DR
          </span>
          <h2>No drafts yet</h2>
          <div className="app-empty-body">
            <p>Start with an instruction: what the document is, who it is for and the terms that matter.</p>
            <p className="app-muted">
              Prepared documents in the library can be attached as references, or left out entirely.
            </p>
            <Link className="app-primary-button" to="/draft/new">
              New draft
            </Link>
          </div>
        </section>
      ) : (
        <div className="app-table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th scope="col">Draft</th>
                <th scope="col">Updated</th>
                <th scope="col">Status</th>
                <th scope="col">References</th>
                <th scope="col">
                  <span className="app-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((draft) => (
                <tr key={draft.id}>
                  <td>
                    <Link className="app-doc-name" to={`/draft/${draft.id}`}>
                      {draft.title || 'Untitled draft'}
                    </Link>
                  </td>
                  <td>{formatUpdated(draft.updatedAt)}</td>
                  <td>
                    <span className={`app-chip app-chip--${statusTone(draft.status)}`}>
                      {draftStatusText(draft.status)}
                    </span>
                  </td>
                  <td>
                    {draft.referenceDocIds.length === 0
                      ? 'None'
                      : `${draft.referenceDocIds.length} document${draft.referenceDocIds.length === 1 ? '' : 's'}`}
                  </td>
                  <td>
                    <div className="app-row-actions">
                      <Link className="app-link-button" to={`/draft/${draft.id}`}>
                        Open
                      </Link>
                      <button
                        type="button"
                        className="app-link-button app-link-button--danger"
                        disabled={deletingId === draft.id}
                        onClick={() => void remove(draft)}
                      >
                        {deletingId === draft.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
