import { useState } from 'react';
import { Modal } from '../Modal';
import { KEEP_OPEN_NOTICE, writeHideStartNotice } from './startNotice';

// Shown before an analysis starts. It only gates the call to the page's existing start
// handler; the checkbox hides this pop-up but never the notice under the inputs.
export function StartNotice({ onStart, onClose }: { onStart: () => void; onClose: () => void }) {
  const [hide, setHide] = useState(false);
  const headingId = 'start-notice-title';

  return (
    <Modal labelledBy={headingId} onClose={onClose}>
      <h2 id={headingId}>Before you start</h2>
      <p className="app-modal-notice">{KEEP_OPEN_NOTICE}</p>
      <label className="app-modal-check">
        <input type="checkbox" checked={hide} onChange={(event) => setHide(event.target.checked)} />
        <span>Do not show this again</span>
      </label>
      <div className="app-modal-actions">
        <button type="button" className="app-modal-secondary" onClick={onClose}>
          Go back
        </button>
        <button
          type="button"
          className="app-primary-button"
          onClick={() => {
            if (hide) writeHideStartNotice();
            onStart();
          }}
        >
          Start analysis
        </button>
      </div>
    </Modal>
  );
}
