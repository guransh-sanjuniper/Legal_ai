import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TestPage } from './ui/TestPage';
import { IngestPage } from './ui/IngestPage';

const page = new URLSearchParams(window.location.search).get('page');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page === 'ingest' ? <IngestPage /> : <TestPage />}
  </StrictMode>,
);
