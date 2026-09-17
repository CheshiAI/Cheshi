import { useEffect, useState, useSyncExternalStore } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { SettingsApi, TypeSafeSettings } from '../../../../shared/settings';

export const autopilotMenuStorageKey = 'cheshi.autopilot.menu-visible';

export function createAutopilotMenuStore(storage: { read(): unknown; write(visible: boolean): void }) {
  let current: boolean | undefined;
  const listeners = new Set<() => void>();
  const read = (): boolean => {
    try {
      const saved = storage.read();
      return saved === 'true';
    } catch { return current ?? false; }
  };
  const getSnapshot = (): boolean => current ??= read();
  const update = (visible: boolean) => {
    const previous = getSnapshot();
    current = visible;
    if (previous !== visible) listeners.forEach(listener => listener());
  };
  return {
    getSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setVisible(visible: boolean) {
      const next = visible === true;
      update(next);
      // Preserve the current selection even when browser storage is unavailable.
      try { storage.write(next); } catch { /* The selection still applies in memory. */ }
    },
    refresh() { update(read()); },
  };
}

const store = createAutopilotMenuStore({
  read: () => typeof window === 'undefined' ? null : window.localStorage.getItem(autopilotMenuStorageKey),
  write: visible => window.localStorage.setItem(autopilotMenuStorageKey, String(visible)),
});
function subscribe(listener: () => void) {
  const unsubscribe = store.subscribe(listener);
  const changed = (event: StorageEvent) => {
    if (event.key === autopilotMenuStorageKey || event.key === null) store.refresh();
  };
  window.addEventListener('storage', changed);
  store.refresh();
  return () => { unsubscribe(); window.removeEventListener('storage', changed); };
}
export function useAutopilotMenu(api = cheshiDesktop?.settings): [boolean, (visible: boolean) => void, boolean] {
  const visible = useSyncExternalStore(subscribe, store.getSnapshot, () => false);
  const [keyState, setKeyState] = useState<{ api: SettingsApi; available: boolean } | null>(null);
  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let changed = false;
    const receive = (state: TypeSafeSettings) => {
      if (disposed) return;
      setKeyState({ api, available: state.source !== 'none' && state.maskedKey !== null && state.error === null });
      if (state.source === 'none') store.setVisible(false);
    };
    const unsubscribe = api.onTypeSafeChanged(state => { changed = true; receive(state); });
    void api.getTypeSafe().then(state => { if (!changed) receive(state); })
      .catch(() => { if (!disposed && !changed) setKeyState({ api, available: false }); });
    return () => { disposed = true; unsubscribe(); };
  }, [api]);
  const available = !!api && keyState?.api === api && keyState.available;
  return [visible && available, next => store.setVisible(next === true && available), available];
}
