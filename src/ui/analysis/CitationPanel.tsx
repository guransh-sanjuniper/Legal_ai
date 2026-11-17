import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { openHarnessDb, type DocumentRecord } from '../../runner/db';
import { openPdf, closePdf, type PdfDoc } from '../../ingest/pdfPages';
import { locateQuote } from '../../analysis/citationLocate';
import type { Citation } from '../../analysis/reportModel';
import { useDeveloperMode } from '../devMode';

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; found: boolean }
  | { status: 'no-pdf' }
  | { status: 'error'; message: string };

// Right-hand panel: the cited page from the stored PDF, with the quote highlighted when it can be
// located in the page's text. Otherwise the page is shown with the stored quote and a note.
export function CitationPanel({ docId, citation, onClose }: { docId: string; citation: Citation | null; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [devOn] = useDeveloperMode();

  useEffect(() => {
    if (!citation) return;
    let alive = true;
    let pdf: PdfDoc | null = null;
    setState({ status: 'loading' });

    (async () => {
      const db = await openHarnessDb();
      const doc = (await db.get('documents', docId)) as DocumentRecord | undefined;
      if (!doc?.pdf) {
        if (alive) setState({ status: 'no-pdf' });
        return;
      }
      pdf = await openPdf(await doc.pdf.arrayBuffer());
      const page = await pdf.getPage(citation.page);
      const viewport = page.getViewport({ scale: 1.4 });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      const text = await page.getTextContent();
      const items = text.items.filter((it): it is typeof it & PdfTextItem => 'str' in it) as unknown as PdfTextItem[];
      const spans = locateQuote(items, citation.quote);
      if (!alive) return;
      if (spans) {
        ctx.fillStyle = 'rgba(255, 214, 0, 0.45)';
        for (const span of spans) {
          const it = items[span.item];
          const m = pdfjs.Util.transform(viewport.transform, it.transform);
          const h = Math.hypot(m[2], m[3]);
          const width = it.width * viewport.scale;
          const x0 = m[4] + (width * span.start) / Math.max(1, it.str.length);
          const x1 = m[4] + (width * span.end) / Math.max(1, it.str.length);
          ctx.fillRect(x0, m[5] - h, Math.max(2, x1 - x0), h);
        }
      }
      setState({ status: 'ready', found: spans !== null });
    })().catch((e) => {
      if (alive) setState({ status: 'error', message: String(e) });
    });

    return () => {
      alive = false;
      if (pdf) void closePdf(pdf);
    };
  }, [docId, citation]);

  if (!citation) return null;

  return (
    <aside className="ana-panel" role="dialog" aria-label="Cited page">
      <div className="ana-panel-head">
        <div>
          <div className="ana-panel-title">Clause {citation.clause} · page {citation.page}</div>
          <div className="app-muted">Source from the stored PDF on this device</div>
        </div>
        <button type="button" className="app-link-button" onClick={onClose}>Close</button>
      </div>
      {state.status === 'loading' && <p className="app-muted">Loading page…</p>}
      {state.status === 'no-pdf' && (
        <p className="ana-note">This document is not stored on this device, so the page cannot be shown. The stored quote is below.</p>
      )}
      {state.status === 'error' && (
        <p className="ana-note">
          The page could not be rendered{devOn ? ` (${state.message})` : ''}. The stored quote is below.
        </p>
      )}
      {state.status === 'ready' && !state.found && (
        <p className="ana-note">The quote could not be located on this page (it may be scanned or reflowed). The stored quote is below.</p>
      )}
      <div className="ana-canvas-wrap" style={{ display: state.status === 'ready' ? 'block' : 'none' }}>
        <canvas ref={canvasRef} className="ana-canvas" />
      </div>
      <blockquote className="ana-quote">“{citation.quote}”</blockquote>
    </aside>
  );
}
