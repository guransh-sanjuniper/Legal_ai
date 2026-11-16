// The Brief's single Continue action. It decides whether the saved draft and plan can be
// opened directly, or whether the instruction must be read again first.

export type BriefContinueAction =
  | 'blocked:instruction'
  | 'navigate'
  | 'save-and-navigate'
  | 'read'
  | 'save-and-read'
  | 'create-and-read';

export interface BriefContinueInput {
  instructionTrimmed: string;
  draftExists: boolean;
  // Any field on the form differs from the saved draft (including the title).
  dirty: boolean;
  // The saved plan matches the form's instruction and reference ids.
  planFreshForForm: boolean;
}

export function decideBriefContinue(input: BriefContinueInput): BriefContinueAction {
  if (!input.instructionTrimmed.trim()) return 'blocked:instruction';
  if (!input.draftExists) return 'create-and-read';
  if (!input.dirty) return input.planFreshForForm ? 'navigate' : 'read';
  return input.planFreshForForm ? 'save-and-navigate' : 'save-and-read';
}
