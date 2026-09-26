import { useLayoutEffect, useRef } from 'react';

/** Let native scrolling own wheel gestures and inertia; synchronize settled pages with tabs. */
export function useScrollSnapTabs(activeIndex: number, onSelect: (index: number) => void) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ activeIndex, onSelect });
  latest.current = { activeIndex, onSelect };
  const requestedIndex = useRef<number | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let width = viewport.clientWidth;
    const align = () => {
      if (!viewport.clientWidth) return;
      requestedIndex.current = latest.current.activeIndex;
      viewport.scrollTo({ left: latest.current.activeIndex * viewport.clientWidth, behavior: 'instant' });
    };
    const settled = (event: Event) => {
      // A file/session list can finish its own vertical scroll inside this viewport.
      if (event.target !== viewport || !viewport.clientWidth) return;
      const index = Math.round(viewport.scrollLeft / viewport.clientWidth);
      if (Math.abs(viewport.scrollLeft - index * viewport.clientWidth) > 1) return;
      // Ignore the completion of an older scroll when a newer tab click is pending.
      if (requestedIndex.current !== null && requestedIndex.current !== index) return;
      requestedIndex.current = null;
      if (index !== latest.current.activeIndex) latest.current.onSelect(index);
    };
    const wheel = (event: WheelEvent) => {
      // User scrolling can interrupt a smooth tab click. Never cancel or classify its packets.
      if (event.deltaX !== 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        requestedIndex.current = null;
      }
    };
    viewport.addEventListener('scrollend', settled);
    viewport.addEventListener('wheel', wheel, { passive: true });
    const observer = new viewport.ownerDocument.defaultView!.ResizeObserver(() => {
      if (width === viewport.clientWidth) return;
      width = viewport.clientWidth;
      align();
    });
    observer.observe(viewport);
    align();
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scrollend', settled);
      viewport.removeEventListener('wheel', wheel);
    };
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport?.clientWidth) return;
    const left = activeIndex * viewport.clientWidth;
    const aligned = Math.abs(viewport.scrollLeft - left) <= 1;
    if (aligned && (requestedIndex.current === null || requestedIndex.current === activeIndex)) return;
    requestedIndex.current = activeIndex;
    const reduceMotion = viewport.ownerDocument.defaultView!.matchMedia('(prefers-reduced-motion: reduce)').matches;
    viewport.scrollTo({ left, behavior: aligned || reduceMotion ? 'instant' : 'smooth' });
  }, [activeIndex]);

  return viewportRef;
}
