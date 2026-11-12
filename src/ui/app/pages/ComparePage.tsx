import { EmptyCard, PageHeader } from './Placeholder';

export function ComparePage() {
  return (
    <>
      <PageHeader
        eyebrow="Module"
        title="Comparator"
        description="Compare clauses, whole documents, or a document against a reference version."
      />
      <EmptyCard title="Comparator is not wired up yet">
        <ul>
          <li>Specific clauses across two documents.</li>
          <li>Similarities across whole documents, aligned by local retrieval.</li>
          <li>A document against a reference document, with a no-match list.</li>
        </ul>
        <p className="app-muted">
          Both documents must be on this device. Quotes and page numbers will come from each side.
        </p>
      </EmptyCard>
    </>
  );
}
