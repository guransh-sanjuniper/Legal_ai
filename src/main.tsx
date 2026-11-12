import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/app/App';
import { TestPage } from './ui/TestPage';
import { IngestPage } from './ui/IngestPage';
import { SearchPage } from './ui/SearchPage';
import { AnalysisPage } from './ui/AnalysisPage';
import { QualityPage } from './ui/QualityPage';

// The harness pages stay reachable at /?page=...; the app shell owns the rest.
const page = new URLSearchParams(window.location.search).get('page');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page === 'ingest' ? (
      <IngestPage />
    ) : page === 'search' ? (
      <SearchPage />
    ) : page === 'analysis' ? (
      <AnalysisPage />
    ) : page === 'quality' ? (
      <QualityPage />
    ) : page === 'test' ? (
      <TestPage />
    ) : (
      <App />
    )}
  </StrictMode>,
);
