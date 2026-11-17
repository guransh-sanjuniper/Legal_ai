import { describe, it, expect } from 'vitest';
import { createDeveloperModeStore, DEVELOPER_MODE_KEY, type DeveloperModeDeps } from './devMode';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function storeWith(deps: Partial<DeveloperModeDeps> & Pick<DeveloperModeDeps, 'getItem' | 'setItem'>) {
  return createDeveloperModeStore({ ...deps });
}

describe('developer mode store', () => {
  it('is off by default and stays off with empty storage', () => {
    const storage = fakeStorage();
    expect(storeWith(storage).get()).toBe(false);
  });

  it('reads a stored value and persists a change', () => {
    const storage = fakeStorage();
    const first = storeWith(storage);
    first.set(true);
    expect(storage.data.get(DEVELOPER_MODE_KEY)).toBe('true');
    expect(first.get()).toBe(true);
    // A fresh store over the same storage (another tab, or a reload) sees it too.
    expect(storeWith(storage).get()).toBe(true);

    first.set(false);
    expect(storeWith(storage).get()).toBe(false);
  });

  it('reads any value other than "true" as off', () => {
    expect(storeWith(fakeStorage({ [DEVELOPER_MODE_KEY]: 'yes' })).get()).toBe(false);
    expect(storeWith(fakeStorage({ [DEVELOPER_MODE_KEY]: 'false' })).get()).toBe(false);
    expect(storeWith(fakeStorage({ [DEVELOPER_MODE_KEY]: 'true' })).get()).toBe(true);
  });

  it('stays off when localStorage is unavailable, and never throws', () => {
    const store = storeWith({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(store.get()).toBe(false);
    expect(() => store.set(true)).not.toThrow();
  });

  it('notifies subscribers, and stops after unsubscribe', () => {
    const store = storeWith(fakeStorage());
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.set(true);
    expect(calls).toBe(1);
    off();
    store.set(false);
    expect(calls).toBe(1);
  });

  it('follows a change made in another tab', () => {
    const storage = fakeStorage();
    let fire: (key: string | null) => void = () => undefined;
    const store = storeWith({
      ...storage,
      addStorageListener: (listener) => {
        fire = listener;
        return () => undefined;
      },
    });
    let calls = 0;
    store.subscribe(() => calls++);
    expect(store.get()).toBe(false);

    storage.data.set(DEVELOPER_MODE_KEY, 'true');
    fire(DEVELOPER_MODE_KEY);
    expect(store.get()).toBe(true);
    expect(calls).toBe(1);

    // Another key, or a notification with no usable value, changes nothing here.
    fire('some.other.key');
    expect(store.get()).toBe(true);
    expect(calls).toBe(1);
  });

  it('does not notify when the cross-tab value did not change', () => {
    const storage = fakeStorage({ [DEVELOPER_MODE_KEY]: 'true' });
    let fire: (key: string | null) => void = () => undefined;
    const store = storeWith({
      ...storage,
      addStorageListener: (listener) => {
        fire = listener;
        return () => undefined;
      },
    });
    let calls = 0;
    store.subscribe(() => calls++);
    expect(store.get()).toBe(true);
    fire(DEVELOPER_MODE_KEY);
    expect(calls).toBe(0);
  });
});
