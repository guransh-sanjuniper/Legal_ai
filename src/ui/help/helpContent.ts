export type HelpSectionId = 'documents' | 'deep-analysis' | 'chat' | 'drafter';

export interface HelpSection {
  id: HelpSectionId;
  title: string;
  whenToUse: string;
  steps: string[];
  tip: string;
}

export const HELP_INTRO = `Add your documents first. Everything else in the app works on documents you've added. AI can make mistakes, so check important points against the original document, and have a lawyer review everything before relying on it.

Long jobs (preparing documents, running a Deep Analysis, writing a draft) run in your browser tab. Keep that tab open until the job finishes, and stay on that page. You can use other tabs or applications in the meantime. If the tab is closed or reloaded, the job stops, but your progress is saved and you can resume it.`;

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: 'documents',
    title: 'Documents',
    whenToUse: 'Use it to add the agreements and other files you want to work with.',
    steps: [
      'Open Documents and choose Import documents, or drag files in. You can add several at once. PDF, Word, text and image files work.',
      'Wait until the status says Ready. Larger or scanned files take longer.',
      'If it says Needs review, open it and check the pages that were hard to read. You can also choose to proceed without reviewing.',
    ],
    tip: 'Tip: a PDF works best. Word files are converted, so page numbers refer to the converted version. While a document is preparing, keep this tab open.',
  },
  {
    id: 'deep-analysis',
    title: 'Deep Analysis',
    whenToUse:
      'Use it to get a full review of one agreement: summary, clauses, dates and amounts, who must do what, risks, and anything missing.',
    steps: [
      'Open Deep Analysis and choose a Ready document.',
      'Choose which side you are reviewing for, and add a focus or a specific question if you want one.',
      'Start the analysis and wait for the report. It can take several minutes for long documents.',
      'Click any quote or page reference to see the exact text in the document. Download the report as Word or HTML.',
    ],
    tip: 'Tip: a specific question gets an answer under "Prompt Result" with numbered sources. Check the sources before relying on it. Keep this tab open and stay on the analysis page until the report is ready. If it stops, use Resume.',
  },
  {
    id: 'chat',
    title: 'Chat',
    whenToUse:
      'Use it to ask legal or drafting questions in plain language, such as what a clause means, how a term works or how to word something. This is the main use of Chat.',
    steps: [
      "Open Chat and type your question. You don't need to pick a document.",
      'Optional: asking about a document. Choose a Ready document to ask about it. Answers show where in the document they came from. This works best for specific questions, such as "What is the notice period?". It can miss things, so check the source shown. If the answer says it isn\'t clearly stated, the document may not say it. Scanning the whole document is slower and costs more, so you\'ll see an estimate to confirm.',
    ],
    tip: '',
  },
  {
    id: 'drafter',
    title: 'Drafter',
    whenToUse:
      "Use it to write a new agreement or letter from your instructions, optionally reusing clauses from documents you've added.",
    steps: [
      'Describe what you need drafted. Choose any reference documents, and say how to use them (for example, "use the indemnity clause from Doc A word for word").',
      'Check the plan, and fill in the details you know. Anything left blank stays as a highlighted [●].',
      'Check the proposed structure. Rearrange, rename or remove sections, then continue.',
      'If you used references, confirm the parts it found.',
      'Writing starts automatically. When it finishes, choose Review and download for a Word file.',
    ],
    tip: 'Tip: the more specific your instruction, the better the result. Fill in the [●] placeholders before you send the draft to anyone. Keep this tab open while the draft is being written. If it stops, open the draft again and choose Resume.',
  },
] as const;

export function helpSection(id: HelpSectionId): HelpSection {
  const section = HELP_SECTIONS.find((entry) => entry.id === id);
  if (!section) throw new Error(`Unknown help section: ${id}`);
  return section;
}

// The module page shows one muted line: whichever of its existing description and the
// Help wording is shorter. Equal lengths keep the Help wording.
export function pickWhenToUse(existing: string | undefined, id: HelpSectionId): string {
  const whenToUse = helpSection(id).whenToUse;
  if (!existing) return whenToUse;
  return existing.length < whenToUse.length ? existing : whenToUse;
}
