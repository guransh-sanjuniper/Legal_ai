const STEPS = [
  { id: 'ingest', label: '1. Ingest', href: '/?page=ingest' },
  { id: 'search', label: '2. Search', href: '/?page=search' },
  { id: 'analysis', label: '3. Analysis', href: '/?page=analysis' },
  { id: 'quality', label: '4. Quality', href: '/?page=quality' },
] as const;

export type StepId = (typeof STEPS)[number]['id'];

// Small pipeline nav shown at the top of every page. The next-step link is the main path.
export function PageNav({ current }: { current: StepId }) {
  const index = STEPS.findIndex((s) => s.id === current);
  const next = STEPS[index + 1];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        fontSize: 13,
        marginBottom: 10,
        paddingBottom: 8,
        borderBottom: '1px solid #e5e5e5',
      }}
    >
      {STEPS.map((s) => (
        <a
          key={s.id}
          href={s.href}
          style={{
            color: s.id === current ? '#111' : '#0645ad',
            fontWeight: s.id === current ? 700 : 400,
            textDecoration: s.id === current ? 'none' : 'underline',
          }}
        >
          {s.label}
        </a>
      ))}
      {next && (
        <a href={next.href} style={{ marginLeft: 'auto', color: '#0645ad', fontWeight: 600 }}>
          Next: {next.label} →
        </a>
      )}
      {!next && (
        <a href={STEPS[0].href} style={{ marginLeft: 'auto', color: '#0645ad' }}>
          Back to ingest →
        </a>
      )}
    </div>
  );
}
