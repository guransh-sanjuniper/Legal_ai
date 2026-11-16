import type { ReviewingFor } from '../analysis/types';

// A draft is a working copy on this device, mirrored to Supabase (table `drafts`) when a
// session is available. D1 writes `status: 'brief'`; D2 adds the parsed plan and particulars
// and writes `planned` when the user confirms the plan. Later stages add the rest.
export type DraftStatus = 'brief' | 'planned' | 'outlined' | 'generating' | 'done' | 'failed';

export const DRAFTER_SCHEMA_VERSION = 1;

export const DEFAULT_REVIEWING_FOR: ReviewingFor = 'neutral';

export type ReferenceMode = 'none' | 'general' | 'specific' | 'mixed';
export type BindingTargetType = 'clause' | 'topic' | 'pages' | 'whole';
export type BindingUseMode = 'verbatim' | 'adapt' | 'style';
export type ParticularKind = 'party' | 'amount' | 'date' | 'property' | 'term' | 'other';

export interface BindingTarget {
  type: BindingTargetType;
  // The user's words for a clause/topic ("14", "indemnity") or a page range ("20-25").
  // Empty for `whole`.
  value: string;
}

export interface SourceBinding {
  id: string;
  // One of draft.referenceDocIds. Never a document the user did not select.
  refDocId: string;
  target: BindingTarget;
  useMode: BindingUseMode;
  // Which part of the NEW document this feeds, in the user's words.
  appliesTo: string;
  // The words from the instruction that produced the binding. Not verified by code.
  phrase: string;
  // Set by the plan screen when the user changes the row.
  edited?: boolean;
}

export interface UnresolvedRef {
  phrase: string;
  reason: string;
}

export interface SourcePlan {
  // Free text from the instruction. Never chosen from a fixed list.
  docType: string;
  summary: string;
  lengthHint: string | null;
  // Always recomputed in code from the bindings and selected documents.
  referenceMode: ReferenceMode;
  bindings: SourceBinding[];
  unresolved: UnresolvedRef[];
  questions: string[];
  parsedAt: string;
  model: string;
  // The Brief the plan was parsed from, so a later Brief edit can be detected.
  parsedFrom: { instruction: string; referenceDocIds: string[] };
}

export interface Particular {
  id: string;
  label: string;
  kind: ParticularKind;
  // Only a value written in the instruction, or one the user typed. Never inferred.
  value: string | null;
  source: 'instruction' | 'user';
  required: boolean;
  edited?: boolean;
}

export interface DraftRecord {
  id: string;
  userId: string;
  title: string;
  instruction: string;
  referenceDocIds: string[];
  reviewingFor: ReviewingFor;
  status: DraftStatus;
  // D1 records have null here and still load.
  particulars: Particular[] | null;
  sourcePlan: SourcePlan | null;
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
