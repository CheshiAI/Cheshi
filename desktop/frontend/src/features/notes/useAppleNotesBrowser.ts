import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AppleNotesApi } from '../../../../shared/apple-notes';
import { createAppleNotesBrowser } from './appleNotesModel';

export function useAppleNotesBrowser(api: AppleNotesApi, browse = true) {
  const [browser] = useState(() => createAppleNotesBrowser(api, browse));
  const state = useSyncExternalStore(browser.subscribe, browser.getSnapshot, browser.getSnapshot);
  useEffect(() => {
    void browser.refresh();
    return browser.dispose;
  }, [browser]);
  return { state, browser };
}
