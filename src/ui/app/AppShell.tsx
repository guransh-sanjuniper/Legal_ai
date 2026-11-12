import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import type { Theme } from './theme';

interface AppShellProps {
  email: string;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  children: ReactNode;
}

// ChatGPT-style frame: fixed sidebar, centred content column, disclaimer at the bottom.
export function AppShell({ email, theme, onToggleTheme, onSignOut, children }: AppShellProps) {
  return (
    <div className="app-root app-shell" data-theme={theme}>
      <Sidebar email={email} theme={theme} onToggleTheme={onToggleTheme} onSignOut={onSignOut} />
      <div className="app-main">
        <main className="app-content">{children}</main>
        <footer className="app-disclaimer">AI-assisted, requires lawyer review.</footer>
      </div>
    </div>
  );
}
