export interface StorageReport {
  persisted: boolean;
  quota: number;
  usage: number;
  free: number;
  neededBytes: number;
  fits: boolean;
}

// The stored PDF, page text, chunks and rendered pages together take a few times the PDF size.
const HEADROOM_FACTOR = 3;

export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}

export async function storageReport(fileBytes: number): Promise<StorageReport> {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : { quota: 0, usage: 0 };
  const quota = est.quota ?? 0;
  const usage = est.usage ?? 0;
  const free = Math.max(0, quota - usage);
  const neededBytes = fileBytes * HEADROOM_FACTOR;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  return { persisted, quota, usage, free, neededBytes, fits: neededBytes <= free };
}
