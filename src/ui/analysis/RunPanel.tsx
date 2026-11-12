import type { AnalysisMetrics } from '../../analysis/types';

export interface RunProgress {
  total: number;
  done: number;
  failed: number;
  active: number;
}

export interface FailedRow {
  id: string;
  label: string;
  pages: string;
  code: string;
  message: string;
  attempts: number;
}

const money = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;

// Progress, counts, metrics, failed tasks and the resume / retry controls.
export function RunPanel({
  running,
  status,
  error,
  progress,
  metrics,
  failedRows,
  canResume,
  canRetry,
  onResume,
  onRetry,
}: {
  running: boolean;
  status: string | null;
  error: string | null;
  progress: RunProgress | null;
  metrics: AnalysisMetrics | null;
  failedRows: FailedRow[];
  canResume: boolean;
  canRetry: boolean;
  onResume: () => void;
  onRetry: () => void;
}) {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="ana-run">
      {error && <div className="app-banner app-banner--error">{error}</div>}
      {status && <p className="app-muted">{status}</p>}

      {progress && (
        <>
          <div className="app-progress" aria-label="Progress">
            <div className="app-progress-bar" style={{ width: `${pct}%` }} />
          </div>
          <p className="app-muted">
            {progress.done} of {progress.total} tasks done · {progress.active} active · {progress.failed} failed
          </p>
        </>
      )}

      {metrics && (
        <dl className="ana-metrics">
          <dt>Calls</dt>
          <dd>{metrics.calls}</dd>
          <dt>Split</dt>
          <dd>{metrics.split}</dd>
          <dt>Failed</dt>
          <dd>{metrics.failed}</dd>
          <dt>Completion tokens</dt>
          <dd>{metrics.completionTokens}</dd>
          <dt>Cost</dt>
          <dd>{money(metrics.costUsd)}</dd>
        </dl>
      )}

      <div className="ana-actions">
        {canResume && (
          <button type="button" className="app-primary-button" onClick={onResume} disabled={running}>
            Resume
          </button>
        )}
        {canRetry && (
          <button type="button" className="app-link-button" onClick={onRetry} disabled={running}>
            Retry failed only
          </button>
        )}
      </div>

      {failedRows.length > 0 && (
        <div className="app-table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Pages</th>
                <th>Failure</th>
                <th>Message</th>
                <th>Attempts</th>
              </tr>
            </thead>
            <tbody>
              {failedRows.map((r) => (
                <tr key={r.id}>
                  <td>{r.label}</td>
                  <td>{r.pages}</td>
                  <td>{r.code}</td>
                  <td>{r.message}</td>
                  <td>{r.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
