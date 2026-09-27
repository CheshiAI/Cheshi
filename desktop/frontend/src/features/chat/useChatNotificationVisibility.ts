import { useLayoutEffect, type RefObject } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';

export function useChatNotificationVisibility(rootRef: RefObject<HTMLElement | null>, contextId: string,
  threadId: string | null, visible: boolean) {
  useLayoutEffect(() => {
    const api = cheshiDesktop?.notificationEvents;
    const root = rootRef.current;
    if (!api || !root) return;
    let intersecting = false;
    const report = () => {
      const shown = visible && intersecting && document.visibilityState === 'visible'
        && !root.closest('[hidden], [inert]');
      void api.reportView(contextId, shown ? threadId : null).catch(() => {});
    };
    const observer = new IntersectionObserver(entries => {
      intersecting = entries.some(entry => entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0);
      report();
    });
    observer.observe(root);
    document.addEventListener('visibilitychange', report);
    report();
    return () => {
      observer.disconnect(); document.removeEventListener('visibilitychange', report);
      void api.reportView(contextId, null).catch(() => {});
    };
  }, [rootRef, contextId, threadId, visible]);
}
