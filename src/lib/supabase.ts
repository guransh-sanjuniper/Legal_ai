import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// The app shell uses the same project (and therefore the same persisted session) as the
// harness pages and the runner worker. Values come from .env.local (local Supabase) or
// .env.hosted (hosted project, loaded with `--mode hosted`).
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '';
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? '';

export const supabaseConfigured = Boolean(url && anonKey);
export const supabaseUrl = url;

export const supabaseProjectHost = (() => {
  if (!url) return 'not configured';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
})();

// A local CLI project or a hosted project. Used only for a label, never for behaviour.
export const supabaseTarget: 'local' | 'hosted' | 'unknown' = (() => {
  if (!url) return 'unknown';
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' ? 'local' : 'hosted';
  } catch {
    return 'unknown';
  }
})();

// persistSession makes the signed-in session available to the harness pages and the
// runner worker, which create their own clients for the same project.
export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;
