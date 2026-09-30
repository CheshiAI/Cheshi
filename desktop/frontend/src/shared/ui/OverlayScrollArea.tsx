import { useCallback, useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';
import { useAutoHideScrollbars } from '../useAutoHideScrollbars';
import { attachElementRef } from '../attachElementRef';
import styles from './OverlayScrollArea.module.css';

/** Keep a native draggable scrollbar over the content instead of reserving a gutter. */
export function OverlayScrollArea({ children, className, label, viewportRef: providedViewportRef }: {
  children: ReactNode; className?: string; label: string; viewportRef?: Ref<HTMLDivElement>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const attachViewport = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    if (!element) return;
    const detach = attachElementRef(providedViewportRef, element);
    return () => { viewportRef.current = null; detach(); };
  }, [providedViewportRef]);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const extentRef = useRef<HTMLDivElement>(null);
  const autoHideRef = useAutoHideScrollbars<HTMLDivElement>();

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const scrollbar = scrollbarRef.current;
    const extent = extentRef.current;
    if (!viewport || !content || !scrollbar || !extent) return;

    const syncFromViewport = () => {
      if (scrollbar.scrollTop !== viewport.scrollTop) scrollbar.scrollTop = viewport.scrollTop;
    };
    const syncFromScrollbar = () => {
      if (viewport.scrollTop !== scrollbar.scrollTop) viewport.scrollTop = scrollbar.scrollTop;
    };
    const measure = () => {
      const overflowing = viewport.scrollHeight > viewport.clientHeight;
      viewport.dataset.overflowing = String(overflowing);
      extent.style.height = `${viewport.scrollHeight}px`;
      scrollbar.hidden = !overflowing;
      syncFromViewport();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    viewport.addEventListener('scroll', syncFromViewport, { passive: true });
    scrollbar.addEventListener('scroll', syncFromScrollbar, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', syncFromViewport);
      scrollbar.removeEventListener('scroll', syncFromScrollbar);
    };
  }, [viewportRef]);

  return <div ref={autoHideRef} className={`${styles.root} ${className ?? ''}`}>
    <div ref={attachViewport} className={styles.viewport} role="region" aria-label={label} tabIndex={0}>
      <div ref={contentRef} className={styles.content}>{children}</div>
    </div>
    <div ref={scrollbarRef} className={styles.scrollbar} aria-hidden="true" tabIndex={-1}>
      <div ref={extentRef} />
    </div>
  </div>;
}
