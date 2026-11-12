import type { DetailLevel } from '../../analysis/types';
import type { RunEstimate } from '../../analysis/costEstimate';

export interface StartFormValues {
  matter: string;
  detailLevel: DetailLevel;
  focus: string;
  customPrompt: string;
}

const money = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;

// Start screen: the four fields the report needs, plus the pre-run estimate.
// The estimate is an upper bound: every call is priced at its full token budget.
export function StartForm({
  values,
  onChange,
  estimate,
  disabled,
  onStart,
  startLabel,
}: {
  values: StartFormValues;
  onChange: (v: StartFormValues) => void;
  estimate: RunEstimate | null;
  disabled: boolean;
  onStart: () => void;
  startLabel: string;
}) {
  const set = <K extends keyof StartFormValues>(k: K, v: StartFormValues[K]) => onChange({ ...values, [k]: v });
  return (
    <form
      className="ana-start"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onStart();
      }}
    >
      <label className="app-field">
        <span>Matter</span>
        <input value={values.matter} maxLength={200} onChange={(e) => set('matter', e.target.value)} placeholder="Client or matter name" />
      </label>
      <label className="app-field">
        <span>Detail level</span>
        <select value={values.detailLevel} onChange={(e) => set('detailLevel', e.target.value as DetailLevel)}>
          <option value="brief">Brief</option>
          <option value="standard">Standard</option>
          <option value="detailed">Detailed</option>
        </select>
      </label>
      <label className="app-field">
        <span>Focus (steers the risk checks only)</span>
        <input value={values.focus} maxLength={300} onChange={(e) => set('focus', e.target.value)} placeholder="Optional" />
      </label>
      <label className="app-field">
        <span>Custom prompt (optional, separate section)</span>
        <textarea
          rows={3}
          maxLength={2000}
          value={values.customPrompt}
          onChange={(e) => set('customPrompt', e.target.value)}
          placeholder="A question answered from the document, with citations"
        />
      </label>
      <div className="ana-estimate">
        {estimate ? (
          <>
            <strong>Upper-bound estimate:</strong> {estimate.calls} calls ({estimate.clauseCalls} clause, {estimate.otherCalls} missing and
            overview, {estimate.customCalls} custom prompt), about {money(estimate.costUsd)}.
            {estimate.customCalls === 0 && <span className="app-muted"> The custom pass is not included because the prompt is empty.</span>}
          </>
        ) : (
          <span className="app-muted">Estimate unavailable.</span>
        )}
      </div>
      <button type="submit" className="app-primary-button" disabled={disabled}>
        {startLabel}
      </button>
    </form>
  );
}
