import { NavLink } from 'react-router-dom';
import { supabaseProjectHost, supabaseTarget } from '../../lib/supabase';
import { useDeveloperMode } from '../devMode';
import { HELP_ITEM, WORKSPACE_ITEMS } from './navItems';
import type { Theme } from './theme';

type IconName = 'plus' | 'chat' | 'document' | 'analysis' | 'draft' | 'compare' | 'help' | 'sun' | 'moon';

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'chat':
      return (
        <svg {...common}>
          <path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
        </svg>
      );
    case 'document':
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
          <path d="M14 3v5h5M9 13h6M9 17h4" />
        </svg>
      );
    case 'analysis':
      return (
        <svg {...common}>
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
          <circle cx="12" cy="12" r="3.2" />
        </svg>
      );
    case 'draft':
      return (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      );
    case 'compare':
      return (
        <svg {...common}>
          <path d="M5 4h5v16H5zM14 4h5v16h-5z" />
        </svg>
      );
    case 'help':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 0 1 4.9 1c0 1.7-2.4 2-2.4 3.5" />
          <path d="M12 17h.01" />
        </svg>
      );
    case 'sun':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </svg>
      );
    case 'moon':
      return (
        <svg {...common}>
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
        </svg>
      );
  }
}

const NAV_ITEMS = [...WORKSPACE_ITEMS, HELP_ITEM];

interface SidebarProps {
  email: string;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
}

export function Sidebar({ email, theme, onToggleTheme, onSignOut }: SidebarProps) {
  const initial = email.trim().charAt(0).toUpperCase() || '?';
  const [devOn, setDevOn] = useDeveloperMode();
  return (
    <aside className="app-sidebar">
      <div className="app-brand">
        <span className="app-brand-mark" aria-hidden="true">
          <Icon name="chat" />
        </span>
        <span className="app-brand-text">
          <strong>Legal Workspace</strong>
          <span>AI document assistant</span>
        </span>
      </div>

      <NavLink to="/chat" className="app-newchat">
        <Icon name="plus" />
        New chat
      </NavLink>

      <nav className="app-nav" aria-label="Workspace">
        <div className="app-sidebar-label">Workspace</div>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `app-nav-link${isActive ? ' is-active' : ''}`}
          >
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="app-sidebar-spacer" />

      <label className="app-dev-mode">
        <input type="checkbox" checked={devOn} onChange={(e) => setDevOn(e.target.checked)} />
        <span>Developer mode</span>
      </label>

      {devOn && (
        <details className="app-dev">
          <summary>Dev: pipeline pages</summary>
          <a href="/?page=ingest">Ingest</a>
          <a href="/?page=search">Search</a>
          <a href="/?page=analysis">Analysis</a>
          <a href="/?page=quality">Quality</a>
          <a href="/?page=test">P1 test</a>
        </details>
      )}

      <div className="app-account">
        <div className="app-account-row">
          <span className="app-avatar" aria-hidden="true">
            {initial}
          </span>
          <span className="app-account-email" title={email}>
            {email}
          </span>
          <button
            type="button"
            className="app-icon-button"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </div>
        <div className="app-account-meta">
          {devOn && (
            <>
              <span className={`app-env app-env--${supabaseTarget}`}>
                {supabaseTarget === 'unknown' ? 'Supabase' : supabaseTarget}
              </span>
              <span className="app-account-host" title={supabaseProjectHost}>
                {supabaseProjectHost}
              </span>
            </>
          )}
          <button type="button" className="app-link-button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
