import { useSyncExternalStore } from 'react';

let count = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** Native terminal surfaces cannot be transformed with the DOM preview. */
export function beginSplitPreview() {
  count++;
  notify();
  return () => { count--; notify(); };
}

export function useSplitPreviewActive() {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => count > 0,
    () => false,
  );
}
