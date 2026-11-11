import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TestPage } from './ui/TestPage';
import { IngestPage } from './ui/IngestPage';
import { SearchPage } from './ui/SearchPage';
import { AnalysisPage } from './ui/AnalysisPage';

const page = new URLSearchParams(window.location.search).get('page');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page === 'ingest' ? (
      <IngestPage />
    ) : page === 'search' ? (
      <SearchPage />
    ) : page === 'analysis' ? (
      <AnalysisPage />
    ) : (
      <TestPage />
    )}
  </StrictMode>,
);
