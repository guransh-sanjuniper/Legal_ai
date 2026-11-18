import type { HelpSectionId } from './helpContent';

// Per-page short instructions. One file so the wording lives in one place; the Help page's
// module sections stay separate and are not duplicated here.
export type PageHelpId =
  | 'documents'
  | 'analysis-list'
  | 'analysis-report'
  | 'chat'
  | 'drafter-brief'
  | 'drafter-plan'
  | 'drafter-outline'
  | 'drafter-sources'
  | 'drafter-write'
  | 'drafter-review';

export interface PageHelp {
  title: string;
  helpAnchor: HelpSectionId;
  steps: string[];
}

export const PAGE_HELP: Record<PageHelpId, PageHelp> = {
  documents: {
    title: 'Documents',
    helpAnchor: 'documents',
    steps: [
      'Press "Import documents" and choose your files. You can choose many at once.',
      'Wait until each file says "Ready".',
      'If a file says "Needs review", open it and check the pages shown.',
      'Keep this tab open while files are being prepared.',
    ],
  },
  'analysis-list': {
    title: 'Deep Analysis',
    helpAnchor: 'deep-analysis',
    steps: [
      'Choose a document that says "Ready".',
      'Open it.',
      'Choose which side you are acting for.',
      'Type a question if you want one answered.',
      'Press Start analysis and keep the page open.',
    ],
  },
  'analysis-report': {
    title: 'Deep Analysis report',
    helpAnchor: 'deep-analysis',
    steps: [
      'Read the report from top to bottom.',
      'Press any page reference to see the exact words in your document.',
      'Press Export DOCX at the top to download the report as a Word file.',
      'Check important points in the original document before relying on them.',
    ],
  },
  chat: {
    title: 'Chat',
    helpAnchor: 'chat',
    steps: [
      'Type your question in the box at the bottom.',
      'You do not need to choose a document.',
      'To ask about a document, choose it first.',
      'Check the source shown under each answer.',
    ],
  },
  'drafter-brief': {
    title: 'Brief',
    helpAnchor: 'drafter',
    steps: [
      'Write what you want drafted.',
      'Choose any documents to copy from, if you wish.',
      'Say which side you are acting for.',
      'Press Continue.',
    ],
  },
  'drafter-plan': {
    title: 'Plan',
    helpAnchor: 'drafter',
    steps: [
      'Check the short summary.',
      'Fill in the details you know, such as names, amounts and dates.',
      'Leave unknown ones blank. They will show as [●].',
      'Press "Looks good, continue".',
    ],
  },
  'drafter-outline': {
    title: 'Structure',
    helpAnchor: 'drafter',
    steps: [
      'Read the list of sections.',
      'Use the arrows to move a section, or press the × button at the end of a section to remove it.',
      'Press "Add a section" if something is missing.',
      'Press "Looks good, continue".',
    ],
  },
  'drafter-sources': {
    title: "Check the parts I'll use",
    helpAnchor: 'drafter',
    steps: [
      'Check each piece of text the app found in your documents.',
      'If it is wrong, type the page numbers and press "Use these pages".',
      'Or choose "Skip this source".',
      'Press "Looks good, continue".',
    ],
  },
  'drafter-write': {
    title: 'Writing your draft',
    helpAnchor: 'drafter',
    steps: [
      'Writing starts by itself.',
      'Keep this tab open until all sections show "Done".',
      'If something fails, press "Try again" beside it.',
      'When finished, press "Review and download".',
    ],
  },
  'drafter-review': {
    title: 'Review your draft',
    helpAnchor: 'drafter',
    steps: [
      'Read the draft.',
      'Highlighted [●] marks are details still to fill in.',
      'Press "Download Word document".',
      'Fill in the [●] details before sending it to anyone.',
    ],
  },
};

export const PAGE_HELP_IDS = Object.keys(PAGE_HELP) as PageHelpId[];

// The drafts list reuses the Brief wording.
export const DRAFTS_LIST_PAGE_ID: PageHelpId = 'drafter-brief';

// Shown under the Deep Analysis inputs and in the start pop-up.
export const KEEP_OPEN_NOTICE =
  'Please keep this page open until the report is ready. This can take several minutes. ' +
  'You may use other tabs or other programs meanwhile, but do not close this tab and do not go ' +
  'to another page of this app. If it stops, come back and press Resume.';
