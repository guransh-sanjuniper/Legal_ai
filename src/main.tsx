import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TestPage } from './ui/TestPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TestPage />
  </StrictMode>,
);
