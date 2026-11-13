import { useState } from 'react';
import type { ReportModel } from '../../analysis/reportModel';
import { buildBlocks } from '../../export/blocks';
import { buildDocx } from '../../export/docx';
import { buildHtml } from '../../export/html';

type Job = 'docx' | 'html';

// Export bar on the report view. The file is built from the in-memory ReportModel, so a report
// restored from Supabase exports the same way. Large reports yield while the blocks are built and
// show clause progress, so the page stays responsive.
export function ExportBar({ model, documentName }: { model: ReportModel; documentName: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileName = (ext: string) => {
    const base = documentName.replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-');
    const date = new Date().toISOString().slice(0, 10);
    return `${base}-${date}.${ext}`;
  };

  function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function run(which: Job) {
    setJob(which);
    setError(null);
    setProgress(null);
    try {
      const blocks = await buildBlocks(model, {
        onProgress: (done, total) => setProgress({ done, total }),
        yieldEvery: 20,
      });
      if (which === 'docx') {
        download(await buildDocx(blocks), fileName('docx'));
      } else {
        download(new Blob([buildHtml(blocks, 'Deep Analysis Report')], { type: 'text/html;charset=utf-8' }), fileName('html'));
      }
    } catch (e) {
      setError(`Export failed: ${String(e)}`);
    } finally {
      setJob(null);
      setProgress(null);
    }
  }

  const busy = job !== null;
  return (
    <div className="ana-export">
      <button type="button" className="app-primary-button" disabled={busy} onClick={() => void run('docx')}>
        {job === 'docx' ? 'Building DOCX…' : 'Export DOCX'}
      </button>
      <button type="button" className="app-link-button" disabled={busy} onClick={() => void run('html')}>
        {job === 'html' ? 'Building HTML…' : 'Export HTML'}
      </button>
      {busy && (
        <span className="app-muted">
          {progress && progress.total > 0 ? `Building clauses ${progress.done} of ${progress.total}…` : 'Preparing export…'}
        </span>
      )}
      {error && <span className="ana-export-error">{error}</span>}
    </div>
  );
}
