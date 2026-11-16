import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthProvider';
import { AppShell } from './AppShell';
import { ConfigMissingPage, LoginPage } from './LoginPage';
import { useTheme, type Theme } from './theme';
import { ChatPage } from './pages/ChatPage';
import { DocumentsPage } from '../library/DocumentsPage';
import { ReviewPage } from '../library/ReviewPage';
import { AnalysisIndexPage } from './pages/AnalysisIndexPage';
import { AnalysisDocPage } from './pages/AnalysisDocPage';
import { DraftsPage } from '../drafter/DraftsPage';
import { DraftEditorPage } from '../drafter/DraftEditorPage';
import { PlanPage } from '../drafter/PlanPage';
import { ComparePage } from './pages/ComparePage';
import './app.css';

function Boot({ theme }: { theme: Theme }) {
  return (
    <div className="app-root app-boot" data-theme={theme}>
      <span className="app-boot-text">Loading workspace…</span>
    </div>
  );
}

function NotFound() {
  return (
    <div className="app-not-found">
      <h1>Page not found</h1>
      <p className="app-muted">The page you asked for does not exist.</p>
      <a className="app-primary-button" href="/documents">
        Go to Documents
      </a>
    </div>
  );
}

function AppRouter({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const { session, loading, configured, signOut } = useAuth();

  if (!configured) return <ConfigMissingPage theme={theme} onToggleTheme={onToggleTheme} />;
  if (loading) return <Boot theme={theme} />;
  if (!session) return <LoginPage theme={theme} onToggleTheme={onToggleTheme} />;

  return (
    <AppShell
      email={session.user.email ?? 'signed in'}
      theme={theme}
      onToggleTheme={onToggleTheme}
      onSignOut={() => void signOut()}
    >
      <Routes>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:sessionId" element={<ChatPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/documents/:docId/review" element={<ReviewPage />} />
        <Route path="/analysis" element={<AnalysisIndexPage />} />
        <Route path="/analysis/:docId" element={<AnalysisDocPage />} />
        <Route path="/draft" element={<DraftsPage />} />
        <Route path="/draft/new" element={<DraftEditorPage />} />
        <Route path="/draft/:draftId" element={<DraftEditorPage />} />
        <Route path="/draft/:draftId/plan" element={<PlanPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
  );
}

// The app shell. Harness pages are still served at /?page=... by main.tsx.
export function App() {
  const { theme, toggleTheme } = useTheme();
  // The shell is edge-to-edge; the harness pages keep their own body margin.
  useEffect(() => {
    const previous = document.body.style.margin;
    document.body.style.margin = '0';
    return () => {
      document.body.style.margin = previous;
    };
  }, []);
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRouter theme={theme} onToggleTheme={toggleTheme} />
      </AuthProvider>
    </BrowserRouter>
  );
}
