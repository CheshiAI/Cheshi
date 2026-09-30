import { useLayoutEffect, useRef } from 'react';

/** Keep three labels visible, with native horizontal scrolling to reveal the rest. */
export function useSidebarTabStrip(activeIndex: number, count: number, visibleCount: number, onSelect: (index: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ activeIndex, count, visibleCount, onSelect });
  latest.current = { activeIndex, count, visibleCount, onSelect };
  const alignRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const viewport = ref.current;
    if (!viewport || count <= visibleCount) return;
    let requestedLeft: number | null = null;
    const stride = () => {
      const tabs = viewport.querySelectorAll<HTMLElement>('[role="tab"]');
      return tabs.length > 1 ? tabs[1]!.getBoundingClientRect().left - tabs[0]!.getBoundingClientRect().left : 0;
    };
    const align = () => {
      const step = stride();
      if (step <= 0 || !viewport.clientWidth) return;
      const { activeIndex, count, visibleCount } = latest.current;
      const start = Math.round(viewport.scrollLeft / step);
      const next = Math.max(0, Math.min(count - visibleCount,
        Math.max(activeIndex - visibleCount + 1, Math.min(start, activeIndex))));
      const left = next * step;
      if (Math.abs(viewport.scrollLeft - left) <= 1) return;
      requestedLeft = left;
      viewport.scrollTo({ left, behavior: 'instant' });
    };
    const settle = (event: Event) => {
      if (event.target !== viewport) return;
      const step = stride();
      if (step <= 0) return;
      if (requestedLeft !== null) {
        if (Math.abs(viewport.scrollLeft - requestedLeft) > 1) return;
        requestedLeft = null;
      }
      const { activeIndex, count, visibleCount, onSelect } = latest.current;
      const start = Math.max(0, Math.min(count - visibleCount, Math.round(viewport.scrollLeft / step)));
      const next = Math.max(start, Math.min(start + visibleCount - 1, activeIndex));
      if (next !== activeIndex) onSelect(next);
    };
    const interrupt = () => { requestedLeft = null; };
    const wheel = (event: WheelEvent) => {
      if (event.deltaX && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) interrupt();
    };
    viewport.addEventListener('scrollend', settle);
    viewport.addEventListener('wheel', wheel, { passive: true });
    viewport.addEventListener('pointerdown', interrupt, { passive: true });
    const observer = new viewport.ownerDocument.defaultView!.ResizeObserver(align);
    observer.observe(viewport);
    alignRef.current = align;
    align();
    return () => {
      alignRef.current = null;
      observer.disconnect();
      viewport.removeEventListener('scrollend', settle);
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('pointerdown', interrupt);
    };
  }, [count, visibleCount]);

  useLayoutEffect(() => { alignRef.current?.(); }, [activeIndex]);
  return ref;
}
