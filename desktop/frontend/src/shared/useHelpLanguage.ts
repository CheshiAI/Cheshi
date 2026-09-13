import { useSyncExternalStore } from 'react';

export type HelpLanguage = 'en' | 'ko';
export const helpLanguageStorageKey = 'cheshi.help.language';
export function normalizeHelpLanguage(value: unknown): HelpLanguage { return value === 'ko' ? 'ko' : 'en'; }

export function createHelpLanguageStore(storage: { read(): unknown; write(language: HelpLanguage): void }) {
  let current: HelpLanguage | undefined;
  const listeners = new Set<() => void>();
  const read = (): HelpLanguage => {
    try { return normalizeHelpLanguage(storage.read()); } catch { return current ?? 'en'; }
  };
  const getSnapshot = (): HelpLanguage => current ??= read();
  const update = (next: HelpLanguage) => {
    const previous = getSnapshot();
    current = next;
    if (previous !== next) listeners.forEach(listener => listener());
  };
  return {
    getSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setLanguage(language: HelpLanguage) {
      const next = normalizeHelpLanguage(language);
      update(next);
      // Keep the current session usable if browser storage is unavailable.
      try { storage.write(next); } catch { /* The selection still applies in memory. */ }
    },
    refresh() { update(read()); },
  };
}

const store = createHelpLanguageStore({
  read: () => typeof window === 'undefined' ? null : window.localStorage.getItem(helpLanguageStorageKey),
  write: language => window.localStorage.setItem(helpLanguageStorageKey, language),
});
function subscribe(listener: () => void) {
  const unsubscribe = store.subscribe(listener);
  const changed = (event: StorageEvent) => {
    if (event.key === helpLanguageStorageKey || event.key === null) store.refresh();
  };
  window.addEventListener('storage', changed);
  store.refresh();
  return () => { unsubscribe(); window.removeEventListener('storage', changed); };
}
export function useHelpLanguage(): [HelpLanguage, (language: HelpLanguage) => void] {
  const language = useSyncExternalStore(subscribe, store.getSnapshot, () => 'en' as const);
  return [language, store.setLanguage];
}
