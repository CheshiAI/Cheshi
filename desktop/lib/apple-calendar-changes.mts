const listeners = new Set<() => void>();
export function onAppleCalendarChanged(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function appleCalendarChanged(): void { listeners.forEach(listener => listener()); }
