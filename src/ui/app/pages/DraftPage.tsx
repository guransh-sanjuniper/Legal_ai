import { EmptyCard, PageHeader } from './Placeholder';

export function DraftPage() {
  return (
    <>
      <PageHeader
        eyebrow="Module"
        title="Drafter"
        description="Draft agreements and notices from a confirmed facts sheet, with placeholders for anything unknown."
      />
      <EmptyCard title="Drafter is not wired up yet">
        <ul>
          <li>A facts sheet you confirm before drafting starts.</li>
          <li>An outline you approve, then one section at a time with shared drafting memory.</li>
          <li>Cross-reference and defined-term checks, placeholders for unknown values, and DOCX export.</li>
        </ul>
        <p className="app-muted">The drafting pipeline will reuse the prepared document and definitions sheet.</p>
      </EmptyCard>
    </>
  );
}
