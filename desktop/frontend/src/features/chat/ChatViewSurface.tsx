import { useLayoutEffect, type HTMLAttributes, type RefObject } from 'react';
import { RegionalBlur } from '../../shared/ui';
import styles from './ChatView.module.css';

/** Keeps message and input edges aligned, including the native scrollbar gutter. */
export function ChatViewSurface({ rootRef, timelineRef, children, ...props }: HTMLAttributes<HTMLElement> & {
  rootRef: RefObject<HTMLElement | null>; timelineRef: RefObject<HTMLElement | null>;
}) {
  useLayoutEffect(() => {
    const root = rootRef.current, timeline = timelineRef.current;
    if (!root || !timeline) return;
    const sync = () => root.style.setProperty('--chat-scrollbar-width', `${Math.max(0, timeline.offsetWidth - timeline.clientWidth)}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(timeline);
    return () => { observer.disconnect(); root.style.removeProperty('--chat-scrollbar-width'); };
  }, [rootRef, timelineRef]);
  return <section {...props} ref={rootRef} className={styles.root}>
    <RegionalBlur sourceRef={timelineRef}>{children}</RegionalBlur>
  </section>;
}
