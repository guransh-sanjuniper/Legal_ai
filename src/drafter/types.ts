import type { ReviewingFor } from '../analysis/types';

// A draft is a working copy on this device, mirrored to Supabase (table `drafts`) when a
// session is available. D1 only writes `status: 'brief'`; the remaining statuses are
// reserved for the planning, outline and generation stages (D2-D6).
export type DraftStatus = 'brief' | 'planned' | 'outlined' | 'generating' | 'done' | 'failed';

export const DRAFTER_SCHEMA_VERSION = 1;

export const DEFAULT_REVIEWING_FOR: ReviewingFor = 'neutral';

export interface DraftRecord {
  id: string;
  userId: string;
  title: string;
  instruction: string;
  referenceDocIds: string[];
  reviewingFor: ReviewingFor;
  status: DraftStatus;
  // Placeholders for D2-D6. They are stored in the `data` jsonb column on Supabase.
  particulars: null;
  sourcePlan: null;
  outline: null;
  clauses: Record<string, unknown>;
  schemaVersion: typeof DRAFTER_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  // Set after a successful push. A draft with syncedAt !== updatedAt is pending sync.
  syncedAt?: string;
}

export type DraftPatch = Partial<
  Pick<
    DraftRecord,
    | 'title'
    | 'instruction'
    | 'referenceDocIds'
    | 'reviewingFor'
    | 'status'
    | 'particulars'
    | 'sourcePlan'
    | 'outline'
    | 'clauses'
  >
>;

export interface NewDraftInput {
  userId: string;
  title?: string;
  instruction: string;
  referenceDocIds?: string[];
  reviewingFor?: ReviewingFor;
}

// A delete is local-first. The tombstone stops a pull from resurrecting the draft and is
// removed once the remote delete succeeds.
export interface DraftDeletion {
  id: string;
  userId: string;
  deletedAt: string;
}
