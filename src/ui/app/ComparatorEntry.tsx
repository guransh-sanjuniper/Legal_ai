import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from '../Modal';
import type { ComparatorItem } from './navItems';

// Comparator is a separate app. The sidebar entry is a button, not a link: it
// explains what happens first, and only the notice's real anchor opens a new tab
// (so a pop-up blocker cannot swallow the window and no app data goes in the URL).
// Nothing here navigates this tab, so the leave guard and running jobs are untouched.

const HEADING_ID = 'comparator-notice-title';

const NOTICE_TEXT =
  'Comparator is a separate app that is still in beta testing, so some features may be incomplete. ' +
  'You will need to sign in again there. It opens in a new tab.';

export function ComparatorEntry({
  item,
  icon,
  externalIcon,
}: {
  item: ComparatorItem;
  icon: ReactNode;
  externalIcon: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // The Modal restores focus to the element that was focused before it opened,
  // which is the sidebar entry after a click. Some browsers do not focus a button
  // on click, so this puts focus back on the entry on every close path.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (wasOpen.current) buttonRef.current?.focus({ preventScroll: true });
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="app-nav-link app-nav-external"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {icon}
        <span>{item.label}</span>
        <span className="app-nav-external-mark">{externalIcon}</span>
      </button>

      {open && (
        <Modal labelledBy={HEADING_ID} onClose={close}>
          <h2 id={HEADING_ID}>Comparator (beta)</h2>
          <p className="app-comparator-text">{NOTICE_TEXT}</p>
          <div className="app-modal-actions">
            <button type="button" className="app-modal-secondary" onClick={close}>
              Cancel
            </button>
            <a
              className="app-primary-button"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={close}
            >
              Open Comparator
            </a>
          </div>
        </Modal>
      )}
    </>
  );
}
