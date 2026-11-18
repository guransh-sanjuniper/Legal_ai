import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from './Modal';
import { PAGE_HELP, type PageHelpId } from './help/pageHelp';

// The visible trigger plus its pop-up. Same wording as the Help page, from pageHelp.ts.
export function HowToUse({ pageId, title }: { pageId: PageHelpId; title?: string }) {
  const [open, setOpen] = useState(false);
  const help = PAGE_HELP[pageId];
  const headingId = `howto-title-${pageId}`;

  return (
    <>
      <button
        type="button"
        className="app-how-to-use"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        How to use this page
      </button>
      {open && (
        <Modal labelledBy={headingId} onClose={() => setOpen(false)}>
          <h2 id={headingId}>{title ?? help.title}</h2>
          <ol className="app-modal-steps">
            {help.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="app-modal-actions">
            <Link className="app-modal-link" to={`/help#${help.helpAnchor}`} onClick={() => setOpen(false)}>
              Read the full help
            </Link>
            <button type="button" className="app-primary-button" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
