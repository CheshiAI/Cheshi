import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Keep three labels visible, with native horizontal scrolling to reveal the rest. */
export function useSidebarTabStrip(activeIndex: number, count: number, visibleCount: number,
  onSelect: (index: number) => void, contentRef: RefObject<HTMLDivElement | null>) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ activeIndex, count, visibleCount, onSelect });
  latest.current = { activeIndex, count, visibleCount, onSelect };
  const alignRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const viewport = ref.current;
    const content = contentRef.current;
    if (!viewport || !content || count <= visibleCount) return;
    let requestedLeft: number | null = null;
    let anchorStart = 0;
    let headerDriven = false;
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
      anchorStart = next;
      const left = next * step;
      if (Math.abs(viewport.scrollLeft - left) <= 1) return;
      requestedLeft = left;
      viewport.scrollTo({ left, behavior: 'instant' });
    };
    const followContent = () => {
      const step = stride();
      if (headerDriven || step <= 0 || !content.clientWidth) return;
      const { count, visibleCount } = latest.current;
      const page = content.scrollLeft / content.clientWidth;
      // Keep the resting window as an anchor so reversals and snap-back retrace the same path.
      const next = Math.max(0, Math.min(count - visibleCount,
        Math.max(page - visibleCount + 1, Math.min(anchorStart, page))));
      const left = next * step;
      viewport.dataset.followingContent = 'true';
      if (Math.abs(viewport.scrollLeft - left) < .01) return;
      requestedLeft = left;
      viewport.scrollTo({ left, behavior: 'instant' });
    };
    const contentScroll = (event: Event) => {
      if (event.target === content) followContent();
    };
    const contentSettled = (event: Event) => {
      if (event.target !== content) return;
      followContent();
      delete viewport.dataset.followingContent;
      headerDriven = false;
      const step = stride();
      if (step > 0) anchorStart = viewport.scrollLeft / step;
    };
    const settle = (event: Event) => {
      if (event.target !== viewport) return;
      const step = stride();
      if (step <= 0) return;
      // Following content creates its own scrollend events; only native header input selects tabs.
      if (requestedLeft !== null) return;
      const { activeIndex, count, visibleCount, onSelect } = latest.current;
      const start = Math.max(0, Math.min(count - visibleCount, Math.round(viewport.scrollLeft / step)));
      anchorStart = start;
      const next = Math.max(start, Math.min(start + visibleCount - 1, activeIndex));
      if (next !== activeIndex) onSelect(next);
      else headerDriven = false;
    };
    const interrupt = () => {
      requestedLeft = null;
      headerDriven = true;
      delete viewport.dataset.followingContent;
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaX && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) interrupt();
    };
    const resumeContent = () => { headerDriven = false; };
    const contentWheel = (event: WheelEvent) => {
      if (event.deltaX && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) resumeContent();
    };
    viewport.addEventListener('scrollend', settle);
    viewport.addEventListener('wheel', wheel, { passive: true });
    viewport.addEventListener('pointerdown', interrupt, { passive: true });
    content.addEventListener('scroll', contentScroll, { passive: true });
    content.addEventListener('scrollend', contentSettled);
    content.addEventListener('wheel', contentWheel, { passive: true });
    content.addEventListener('pointerdown', resumeContent, { passive: true });
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
      content.removeEventListener('scroll', contentScroll);
      content.removeEventListener('scrollend', contentSettled);
      content.removeEventListener('wheel', contentWheel);
      content.removeEventListener('pointerdown', resumeContent);
      delete viewport.dataset.followingContent;
    };
  }, [count, visibleCount, contentRef]);

  useLayoutEffect(() => { alignRef.current?.(); }, [activeIndex]);
  return ref;
}
