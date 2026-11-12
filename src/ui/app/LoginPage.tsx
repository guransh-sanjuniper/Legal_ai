import { useState, type FormEvent, type ReactNode } from 'react';
import { supabase, supabaseProjectHost, supabaseTarget } from '../../lib/supabase';
import type { Theme } from './theme';

function ThemeButton({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  return (
    <button
      type="button"
      className="app-icon-button app-icon-button--bordered"
      onClick={onToggleTheme}
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}

function LoginFrame({ theme, onToggleTheme, children }: { theme: Theme; onToggleTheme: () => void; children: ReactNode }) {
  return (
    <div className="app-root app-login" data-theme={theme}>
      <header className="app-login-top">
        <div className="app-brand">
          <span className="app-brand-mark" aria-hidden="true">
            LW
          </span>
          <span className="app-brand-text">
            <strong>Legal Workspace</strong>
            <span>AI document assistant</span>
          </span>
        </div>
        <ThemeButton theme={theme} onToggleTheme={onToggleTheme} />
      </header>
      <main className="app-login-main">{children}</main>
      <footer className="app-disclaimer">AI-assisted, requires lawyer review.</footer>
    </div>
  );
}

export function LoginPage({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (signInError) setError(signInError.message);
    setBusy(false);
  }

  return (
    <LoginFrame theme={theme} onToggleTheme={onToggleTheme}>
      <div className="app-login-card">
        <div className="app-eyebrow">{supabaseTarget === 'local' ? 'Local Supabase' : 'Hosted Supabase'}</div>
        <h1>Sign in</h1>
        <p className="app-muted">Access the document workspace. Your PDFs stay on this device.</p>
        <form onSubmit={submit} className="app-form">
          <label className="app-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              autoFocus
              disabled={busy}
            />
          </label>
          <label className="app-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              disabled={busy}
            />
          </label>
          {error && (
            <div className="app-form-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="app-primary-button" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="app-login-hint">
          Connected to <code>{supabaseProjectHost}</code>. Accounts are created by an administrator.
        </p>
      </div>
    </LoginFrame>
  );
}

export function ConfigMissingPage({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  return (
    <LoginFrame theme={theme} onToggleTheme={onToggleTheme}>
      <div className="app-login-card">
        <div className="app-eyebrow">Configuration</div>
        <h1>Supabase is not configured</h1>
        <p className="app-muted">The app shell needs a project URL and anon key before it can sign in.</p>
        <ol className="app-config-list">
          <li>
            Copy <code>.env.hosted.example</code> to <code>.env.hosted</code> and fill in the hosted project values.
          </li>
          <li>
            Or keep the local project values in <code>.env.local</code>.
          </li>
          <li>
            Start with <code>npm run dev</code> (local) or <code>npm run dev:hosted</code> (hosted).
          </li>
        </ol>
        <p className="app-muted">
          Required variables: <code>VITE_SUPABASE_URL</code>, <code>VITE_SUPABASE_ANON_KEY</code>.
        </p>
      </div>
    </LoginFrame>
  );
}
