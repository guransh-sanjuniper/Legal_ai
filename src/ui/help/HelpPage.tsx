import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { PageHeader } from '../app/pages/Placeholder';
import { HELP_INTRO, HELP_SECTIONS } from './helpContent';
import './help.css';

export function HelpPage() {
  const location = useLocation();

  useEffect(() => {
    const id = location.hash.replace(/^#/, '');
    if (!id) return;
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ block: 'start' });
  }, [location.hash]);

  return (
    <div className="help-page">
      <PageHeader eyebrow="Guide" title="Help" />

      <section className="help-intro" aria-labelledby="help-intro-title">
        <h2 id="help-intro-title">Before you start</h2>
        {HELP_INTRO.split('\n\n').map((paragraph) => (
          <p key={paragraph.slice(0, 40)}>{paragraph}</p>
        ))}
      </section>

      {HELP_SECTIONS.map((section) => (
        <section key={section.id} id={section.id} className="help-section" aria-labelledby={`${section.id}-title`}>
          <h2 id={`${section.id}-title`}>{section.title}</h2>
          <p className="help-when-to-use">{section.whenToUse}</p>
          <ol className="help-steps">
            {section.steps.map((step) => (
              <li key={step.slice(0, 40)}>{step}</li>
            ))}
          </ol>
          {section.tip && <p className="help-tip">{section.tip}</p>}
        </section>
      ))}
    </div>
  );
}
