import { useState } from 'react';
import { estimateCost } from '../../analysis/config';

export interface PromptBoxState {
  prompt: string;
  mode: 'retrieval' | 'whole';
}

// A prompt asked after the report exists. Retrieval reads only the most relevant sections; whole
// document reads every section. The estimate shows the calls for each mode.
export function PromptBox({
  totalChunks,
  avgChunkTokens,
  retrievalCount,
  busy,
  onRun,
}: {
  totalChunks: number;
  avgChunkTokens: number;
  retrievalCount: number;
  busy: boolean;
  onRun: (state: PromptBoxState) => void;
}) {
  const [state, setState] = useState<PromptBoxState>({ prompt: '', mode: 'retrieval' });
  const calls = state.mode === 'retrieval' ? Math.min(retrievalCount, totalChunks) + 1 : totalChunks + 1;
  const readChunks = state.mode === 'retrieval' ? Math.min(retrievalCount, totalChunks) : totalChunks;
  // Rough upper bound: each read chunk plus the prompt, and one synthesis.
  const cost = estimateCost(readChunks * (avgChunkTokens + 250), readChunks * 160 + 800);

  return (
    <div className="ana-prompt">
      <div className="ana-card-title">Ask a question about this report</div>
      <label className="app-field">
        <span>Custom prompt</span>
        <textarea
          rows={2}
          maxLength={2000}
          value={state.prompt}
          onChange={(e) => setState({ ...state, prompt: e.target.value })}
          placeholder="A question answered from the document, with citations"
        />
      </label>
      <div className="ana-prompt-modes">
        <label>
          <input
            type="radio"
            name="prompt-mode"
            checked={state.mode === 'retrieval'}
            onChange={() => setState({ ...state, mode: 'retrieval' })}
          />{' '}
          Most relevant sections ({Math.min(retrievalCount, totalChunks)} of {totalChunks})
        </label>
        <label>
          <input
            type="radio"
            name="prompt-mode"
            checked={state.mode === 'whole'}
            onChange={() => setState({ ...state, mode: 'whole' })}
          />{' '}
          Scan whole document ({totalChunks})
        </label>
      </div>
      <p className="app-muted">
        Estimate: {calls} calls, about ${cost.toFixed(2)}. {state.mode === 'retrieval' ? 'Reads only the selected sections.' : 'Reads every section.'}
      </p>
      <button
        type="button"
        className="app-primary-button"
        disabled={busy || !state.prompt.trim()}
        onClick={() => onRun({ ...state, prompt: state.prompt.trim() })}
      >
        {busy ? 'Running…' : 'Ask'}
      </button>
    </div>
  );
}
