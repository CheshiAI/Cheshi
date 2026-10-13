import { useCallback, useId, useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';
import { useAutoHideScrollbars } from '../useAutoHideScrollbars';
import { attachElementRef } from '../attachElementRef';
import styles from './OverlayScrollArea.module.css';

/** Keep a native draggable scrollbar over the content instead of reserving a gutter. */
export function OverlayScrollArea({ children, className, label, viewportRef: providedViewportRef }: {
  children: ReactNode; className?: string; label: string; viewportRef?: Ref<HTMLDivElement>;
}) {
  const viewportId = useId();
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
      scrollbar.setAttribute('aria-valuenow', String(viewport.scrollTop));
    };
    const syncFromScrollbar = () => {
      if (viewport.scrollTop !== scrollbar.scrollTop) viewport.scrollTop = scrollbar.scrollTop;
      scrollbar.setAttribute('aria-valuenow', String(viewport.scrollTop));
    };
    const measure = () => {
      const overflowing = viewport.scrollHeight > viewport.clientHeight;
      viewport.dataset.overflowing = String(overflowing);
      // Match the viewport height when a consumer enables a horizontal scrollbar.
      scrollbar.style.bottom = `${Math.max(0, viewport.offsetHeight - viewport.clientHeight)}px`;
      extent.style.height = `${viewport.scrollHeight}px`;
      scrollbar.setAttribute('aria-valuemax', String(Math.max(0, viewport.scrollHeight - viewport.clientHeight)));
      if (!overflowing && scrollbar === document.activeElement) viewport.focus({ preventScroll: true });
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
    <div id={viewportId} ref={attachViewport} className={styles.viewport} role="region" aria-label={label} tabIndex={0}>
      <div ref={contentRef} className={styles.content}>{children}</div>
    </div>
    <div ref={scrollbarRef} className={styles.scrollbar} role="scrollbar" aria-label={label}
      aria-controls={viewportId} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={0} aria-valuenow={0} tabIndex={-1}>
      <div ref={extentRef} />
    </div>
  </div>;
}
