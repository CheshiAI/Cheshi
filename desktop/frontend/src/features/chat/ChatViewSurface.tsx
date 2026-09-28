import { useLayoutEffect, useRef, type HTMLAttributes, type RefObject } from 'react';
import { RegionalBlur } from '../../shared/ui';
import styles from './ChatView.module.css';

/** Keeps message and input edges aligned, including the native scrollbar gutter. */
export function ChatViewSurface({ rootRef, timelineRef, children, ...props }: HTMLAttributes<HTMLElement> & {
  rootRef: RefObject<HTMLElement | null>; timelineRef: RefObject<HTMLElement | null>;
}) {
  const connection = useRef<{ root: HTMLElement; timeline: HTMLElement; dispose: () => void } | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current, timeline = timelineRef.current;
    if (connection.current?.root === root && connection.current?.timeline === timeline) return;
    connection.current?.dispose();
    connection.current = null;
    if (!root || !timeline) return;
    let connected = true;
    const sync = (width: number) => {
      if (connected && width > 0) root.style.setProperty('--chat-viewport-width', `${width}px`);
    };
    // Share the timeline's usable width, including fractional sizes at different zoom levels.
    sync(timeline.clientWidth);
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(item => item.target === timeline);
      if (entry) sync(entry.contentRect.width);
    });
    observer.observe(timeline);
    connection.current = { root, timeline, dispose: () => {
      connected = false;
      observer.disconnect();
      root.style.removeProperty('--chat-viewport-width');
    } };
  });
  useLayoutEffect(() => () => { connection.current?.dispose(); connection.current = null; }, []);
  return <section {...props} ref={rootRef} className={styles.root}>
    <RegionalBlur sourceRef={timelineRef}>{children}</RegionalBlur>
  </section>;
}
