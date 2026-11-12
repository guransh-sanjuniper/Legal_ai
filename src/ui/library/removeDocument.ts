import { deleteEmbeddingsForDoc, type DocumentRecord, type HarnessDBHandle } from '../../runner/db';

const pageRange = (docId: string) => IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]);
const chunkRange = (docId: string) => IDBKeyRange.bound(`${docId}:`, `${docId}:\uffff`);

// Returns which existing lock would make removal unsafe, or null when nothing is running.
export async function documentLock(doc: DocumentRecord): Promise<'preparation' | 'analysis' | null> {
  if (!navigator.locks?.query) return null;
  try {
    const { held } = await navigator.locks.query();
    if (held?.some((lock) => lock.name === `ingest:${doc.id}`)) return 'preparation';
    if (held?.some((lock) => lock.name === `doc:${doc.hash}`)) return 'analysis';
    return null;
  } catch {
    return null;
  }
}

// Local-only removal. Reports and results already saved to Supabase are kept.
export async function removeDocumentFromDevice(db: HarnessDBHandle, doc: DocumentRecord): Promise<void> {
  await deleteEmbeddingsForDoc(db, doc.id);

  const tasks = (await db.getAll('tasks')).filter((task) => task.docHash === doc.hash);
  const tx = db.transaction(
    [
      'documents',
      'pages',
      'chunks',
      'ocr_decisions',
      'embeddings',
      'definitions',
      'analysis_reports',
      'analysis_state',
      'tasks',
      'raw_responses',
      'run_state',
    ],
    'readwrite',
  );

  await tx.objectStore('documents').delete(doc.id);
  await tx.objectStore('pages').delete(pageRange(doc.id));
  await tx.objectStore('chunks').delete(chunkRange(doc.id));
  await tx.objectStore('ocr_decisions').delete(pageRange(doc.id));
  // Legacy rows only; current embeddings live in embedding_windows (deleted above).
  await tx.objectStore('embeddings').delete(chunkRange(doc.id));
  await tx.objectStore('definitions').delete(doc.id);
  await tx.objectStore('analysis_state').delete(doc.id);

  const reportKeys = await tx.objectStore('analysis_reports').index('byDoc').getAllKeys(doc.id);
  for (const key of reportKeys) await tx.objectStore('analysis_reports').delete(key);

  for (const task of tasks) {
    await tx.objectStore('tasks').delete(task.id);
    const rawKeys = await tx.objectStore('raw_responses').getAllKeys(IDBKeyRange.bound(`${task.id}|`, `${task.id}|\uffff`));
    for (const key of rawKeys) await tx.objectStore('raw_responses').delete(key);
  }

  const runKeys = await tx.objectStore('run_state').getAllKeys();
  for (const key of runKeys) {
    const row = await tx.objectStore('run_state').get(key);
    if (row?.docHash === doc.hash) await tx.objectStore('run_state').delete(key);
  }

  await tx.done;
}
