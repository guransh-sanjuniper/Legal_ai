import { Link } from 'react-router-dom';
import {
  referenceViews,
  selectableReferences,
  type LibraryEntry,
} from '../../drafter/references';

// Multi-select over the library's Ready documents. A saved reference that is no longer Ready
// or no longer on this device stays selected and is shown with its reason; it is only
// removed when the user says so.
export function ReferencePicker({
  library,
  selectedIds,
  onChange,
  disabled,
}: {
  library: LibraryEntry[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const options = selectableReferences(library);
  const unavailable = referenceViews(selectedIds, library).filter((view) => view.availability !== 'ready');

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((current) => current !== id));
    else onChange([...selectedIds, id]);
  };

  return (
    <fieldset className="drafter-references">
      <legend>Reference documents</legend>
      <p className="app-muted drafter-ref-help">
        Optional. Only documents that have finished preparation are listed. Leave empty to draft from the instruction
        alone.
      </p>

      {options.length === 0 ? (
        <p className="app-muted">
          No prepared documents on this device yet. <Link to="/documents">Add a document</Link> and let it finish
          preparation.
        </p>
      ) : (
        <div className="drafter-ref-list">
          {options.map((doc) => (
            <label key={doc.id} className="drafter-ref-row">
              <input
                type="checkbox"
                checked={selectedIds.includes(doc.id)}
                disabled={disabled}
                onChange={() => toggle(doc.id)}
              />
              <span className="drafter-ref-text">
                <span className="drafter-ref-name">{doc.name}</span>
                <span className="app-doc-meta">
                  {doc.pageCount > 0 ? `${doc.pageCount} pages` : 'Page count unavailable'}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}

      {unavailable.length > 0 && (
        <div className="drafter-ref-list drafter-ref-list--unavailable">
          {unavailable.map((view) => (
            <div key={view.id} className="drafter-ref-row drafter-ref-row--unavailable">
              <input type="checkbox" checked disabled readOnly />
              <span className="drafter-ref-text">
                <span className="drafter-ref-name">{view.name ?? 'Unnamed reference'}</span>
                <span className="drafter-ref-note">
                  {view.availability === 'missing'
                    ? 'Not on this device. It stays attached to this draft.'
                    : 'On this device but not prepared. It stays attached to this draft.'}
                </span>
              </span>
              <button
                type="button"
                className="app-link-button app-link-button--danger"
                disabled={disabled}
                onClick={() => onChange(selectedIds.filter((id) => id !== view.id))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="app-muted drafter-ref-help">
        <Link to="/documents">Add a document</Link>
      </p>
    </fieldset>
  );
}
