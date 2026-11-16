import { useCallback } from 'react';

const SCROLLBAR_IDLE_MS = 700;

/** Share the same activity lifecycle between React panels and editor views. */
export function installAutoHideScrollbars(surface: HTMLElement) {
  const view = surface.ownerDocument.defaultView;
  if (!view) return () => {};
  const timers = new Map<HTMLElement, number>();
  surface.setAttribute('data-auto-hide-scrollbars', 'true');

  const onScroll = (event: Event) => {
    const target = event.target;
    if (!(target instanceof view.HTMLElement)) return;
    const previous = timers.get(target);
    if (previous !== undefined) view.clearTimeout(previous);
    target.setAttribute('data-scrollbar-active', 'true');
    timers.set(target, view.setTimeout(() => {
      timers.delete(target);
      // Keep the transition rule attached while the color fades to transparent.
      target.setAttribute('data-scrollbar-active', 'false');
    }, SCROLLBAR_IDLE_MS));
  };

  // Native scroll events do not bubble; capture nested lists as well as the root.
  surface.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    surface.removeEventListener('scroll', onScroll, { capture: true });
    for (const [target, timer] of timers) {
      view.clearTimeout(timer);
      target.removeAttribute('data-scrollbar-active');
    }
    timers.clear();
    surface.removeAttribute('data-scrollbar-active');
    for (const target of surface.querySelectorAll('[data-scrollbar-active]')) {
      target.removeAttribute('data-scrollbar-active');
    }
    surface.removeAttribute('data-auto-hide-scrollbars');
  };
}

export function useAutoHideScrollbars<T extends HTMLElement>() {
  return useCallback((surface: T | null) => (
    surface ? installAutoHideScrollbars(surface) : undefined
  ), []);
}
