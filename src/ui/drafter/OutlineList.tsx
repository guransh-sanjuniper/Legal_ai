import {
  attachBinding,
  bindingLabel,
  canIndent,
  canMove,
  canOutdent,
  detachBinding,
  indentItem,
  moveItem,
  numbering,
  outdentItem,
  renameItem,
  setPurpose,
} from '../../drafter/outline';
import type { DocAlias } from '../../drafter/plan';
import type { OutlineItem, SourceBinding } from '../../drafter/types';

// The structure list. Numbering is computed for display only; order and level are the data.

export function OutlineList({
  items,
  bindings,
  docs,
  disabled,
  onItems,
  onDelete,
  onAdd,
}: {
  items: OutlineItem[];
  bindings: SourceBinding[];
  docs: DocAlias[];
  disabled?: boolean;
  onItems: (items: OutlineItem[]) => void;
  onDelete: (item: OutlineItem) => void;
  onAdd: (afterId: string | null) => void;
}) {
  const labels = numbering(items);

  return (
    <ol className="drafter-outline-list">
      {items.map((item, index) => {
        const attached = item.bindingIds
          .map((id) => bindings.find((binding) => binding.id === id))
          .filter((binding): binding is SourceBinding => Boolean(binding));
        const available = bindings.filter((binding) => !item.bindingIds.includes(binding.id));

        return (
          <li key={item.id} className={`drafter-outline-row drafter-outline-row--level${item.level}`}>
            <div className="drafter-outline-main">
              <span className="drafter-outline-number">{labels[index] || '•'}</span>

              <div className="drafter-outline-fields">
                <input
                  className="drafter-outline-title"
                  value={item.title}
                  disabled={disabled}
                  aria-label={`Section ${index + 1} title`}
                  onChange={(e) => onItems(renameItem(items, item.id, e.target.value))}
                />
                <input
                  className="drafter-outline-purpose"
                  value={item.purpose}
                  disabled={disabled}
                  aria-label={`Section ${index + 1}: what it covers`}
                  placeholder="What it covers (optional)"
                  onChange={(e) => onItems(setPurpose(items, item.id, e.target.value))}
                />

                {(attached.length > 0 || available.length > 0) && (
                  <div className="drafter-outline-uses">
                    {attached.map((binding) => (
                      <span key={binding.id} className="app-chip app-chip--neutral drafter-uses-chip">
                        Uses: {bindingLabel(binding, docs)}
                        <button
                          type="button"
                          className="drafter-chip-remove"
                          disabled={disabled}
                          aria-label={`Remove ${bindingLabel(binding, docs)}`}
                          onClick={() => onItems(detachBinding(items, item.id, binding.id))}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {available.length > 0 && (
                      <select
                        className="drafter-uses-select"
                        value=""
                        disabled={disabled}
                        aria-label={`Attach a source to section ${index + 1}`}
                        onChange={(e) => {
                          if (e.target.value) onItems(attachBinding(items, item.id, e.target.value));
                        }}
                      >
                        <option value="">Attach a source…</option>
                        {available.map((binding) => (
                          <option key={binding.id} value={binding.id}>
                            {bindingLabel(binding, docs)}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>

              <div className="drafter-outline-controls">
                <button
                  type="button"
                  className="drafter-icon-button"
                  title="Move up"
                  aria-label="Move up"
                  disabled={disabled || !canMove(items, item.id, -1)}
                  onClick={() => onItems(moveItem(items, item.id, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="drafter-icon-button"
                  title="Move down"
                  aria-label="Move down"
                  disabled={disabled || !canMove(items, item.id, 1)}
                  onClick={() => onItems(moveItem(items, item.id, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="drafter-icon-button"
                  title="Make it a sub-section"
                  aria-label="Make it a sub-section"
                  disabled={disabled || !canIndent(items, item.id)}
                  onClick={() => onItems(indentItem(items, item.id))}
                >
                  →
                </button>
                <button
                  type="button"
                  className="drafter-icon-button"
                  title="Make it a main section"
                  aria-label="Make it a main section"
                  disabled={disabled || !canOutdent(items, item.id)}
                  onClick={() => onItems(outdentItem(items, item.id))}
                >
                  ←
                </button>
                <button
                  type="button"
                  className="drafter-icon-button drafter-icon-button--danger"
                  title="Delete this section"
                  aria-label="Delete this section"
                  disabled={disabled}
                  onClick={() => onDelete(item)}
                >
                  ×
                </button>
              </div>
            </div>

            <button
              type="button"
              className="app-link-button drafter-add-between"
              disabled={disabled}
              onClick={() => onAdd(item.id)}
            >
              + Add section
            </button>
          </li>
        );
      })}
    </ol>
  );
}
