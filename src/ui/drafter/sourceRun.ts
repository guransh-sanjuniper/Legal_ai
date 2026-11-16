import { openHarnessDb } from '../../runner/db';
import { resolveAll } from '../../drafter/resolveRef';
import type { DraftRecord, SourceText } from '../../drafter/types';

// Resolves the bound sources from this device's stored text. Read-only over the harness DB.
export async function resolveDraftSources(draft: DraftRecord): Promise<SourceText> {
  const harness = await openHarnessDb();
  return resolveAll(harness, draft);
}
