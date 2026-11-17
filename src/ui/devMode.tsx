import { useCallback, useEffect, useState, type ReactNode } from 'react';

// Developer mode is a render-time switch for technical diagnostics. It is off for everyone by
// default and stored per browser; turning it on shows exactly the screens as they were before the
// toggle existed. Nothing is stored, computed or saved differently.

export const DEVELOPER_MODE_KEY = 'legal-app.developerMode';

export interface DeveloperModeStore {
  get(): boolean;
  set(on: boolean): void;
  subscribe(listener: () => void): () => void;
}

export interface DeveloperModeDeps {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  // Cross-tab updates: the storage event does not fire in the tab that wrote the value.
  addStorageListener?(listener: (key: string | null) => void): () => void;
}

// Read/write access is injected so the store can be exercised without a browser. Every storage
// call is guarded: an unavailable localStorage reads as "off" and a failed write is ignored.
export function createDeveloperModeStore(deps: DeveloperModeDeps): DeveloperModeStore {
  let value: boolean | null = null;
  const listeners = new Set<() => void>();

  const read = (): boolean => {
    try {
      return deps.getItem(DEVELOPER_MODE_KEY) === 'true';
    } catch {
      return false;
    }
  };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const get = (): boolean => {
    if (value === null) value = read();
    return value;
  };
  const refresh = () => {
    const next = read();
    if (next === value) {
      value = next;
      return;
    }
    value = next;
    notify();
  };
  const set = (on: boolean) => {
    value = on;
    try {
      deps.setItem(DEVELOPER_MODE_KEY, String(on));
    } catch {
      // Private mode or a full quota: the toggle still works for this visit.
    }
    notify();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  deps.addStorageListener?.((key) => {
    if (key === null || key === DEVELOPER_MODE_KEY) refresh();
  });
  return { get, set, subscribe };
}

function browserDeps(): DeveloperModeDeps {
  if (typeof window === 'undefined') return { getItem: () => null, setItem: () => undefined };
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    addStorageListener: (listener) => {
      const handler = (event: StorageEvent) => listener(event.key);
      window.addEventListener('storage', handler);
      return () => window.removeEventListener('storage', handler);
    },
  };
}

export const developerMode = createDeveloperModeStore(browserDeps());

export function useDeveloperMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => developerMode.get());
  useEffect(() => developerMode.subscribe(() => setOn(developerMode.get())), []);
  const update = useCallback((next: boolean) => developerMode.set(next), []);
  return [on, update];
}

// Renders its children only when Developer mode is on. Use for whole blocks; a boolean from
// useDeveloperMode is used for fragments inside a line.
export function DevOnly({ children }: { children: ReactNode }) {
  const [on] = useDeveloperMode();
  return on ? <>{children}</> : null;
}
