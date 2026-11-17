import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function PageHeader({
  eyebrow,
  title,
  description,
  whenToUse,
  helpHref,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  whenToUse?: string;
  helpHref?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="app-page-header">
      <div>
        {eyebrow && <div className="app-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p className="app-page-description">{description}</p>}
        {whenToUse && (
          <p className="app-when-to-use">
            When to use this: {whenToUse}
            {helpHref && (
              <>
                {' · '}
                <Link to={helpHref}>See Help</Link>
              </>
            )}
          </p>
        )}
      </div>
      {actions && <div className="app-page-actions">{actions}</div>}
    </header>
  );
}

function Glyph() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EmptyCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="app-empty-card">
      <span className="app-empty-glyph">
        <Glyph />
      </span>
      <h2>{title}</h2>
      <div className="app-empty-body">{children}</div>
    </section>
  );
}
