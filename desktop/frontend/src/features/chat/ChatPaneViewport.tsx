import { useLayoutEffect, useRef } from 'react';
import { SplitPaneLayout, type SplitPaneLayoutProps } from '../../shared/ui/SplitPaneLayout';
import { splitPaneMinimumWidth } from '../../shared/ui/splitPaneSizing';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { CHAT_PANE_MIN_WIDTH } from './chatWorkspaceModel';
import styles from './ChatWorkspace.module.css';

interface ChatPaneViewportProps extends Pick<SplitPaneLayoutProps, 'layout' | 'renderPane' | 'onResizeSplit'> {
  activePaneId: string;
  onSelectPane(paneId: string): void;
}

export function ChatPaneViewport({ activePaneId, onSelectPane, ...layoutProps }: ChatPaneViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollbarsRef = useAutoHideScrollbars<HTMLDivElement>();
  const requestedScrollLeft = useRef<number | null>(null);
  const scrollSelectedPane = useRef<string | null>(null);
  const latest = useRef({ activePaneId, onSelectPane });
  latest.current = { activePaneId, onSelectPane };

  const revealActive = (behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    if (!viewport?.clientWidth) return;
    const pane = [...viewport.querySelectorAll<HTMLElement>('[data-chat-pane-mount]')]
      .find(element => element.dataset.chatPaneMount === latest.current.activePaneId);
    if (!pane) return;
    const frame = viewport.getBoundingClientRect();
    const bounds = pane.getBoundingClientRect();
    const left = bounds.left - frame.left;
    const right = bounds.right - frame.left;
    // Already visible panes stay in place. Only scroll this viewport, never the conversation.
    const offset = left < 0 ? left : right > viewport.clientWidth ? Math.min(left, right - viewport.clientWidth) : 0;
    // Programmatic moves use a snap boundary too, so native snapping cannot settle elsewhere.
    const targetLeft = Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth,
      viewport.scrollLeft + (Math.abs(offset) > 1 ? left : 0)));
    const aligned = Math.abs(targetLeft - viewport.scrollLeft) <= 1;
    if (aligned && requestedScrollLeft.current === null) return;
    requestedScrollLeft.current = targetLeft;
    viewport.scrollTo({ left: targetLeft, behavior: aligned ? 'instant' : behavior });
  };
  const revealRef = useRef(revealActive);
  revealRef.current = revealActive;

  useLayoutEffect(() => {
    const viewport = viewportRef.current!;
    const settled = (event: Event) => {
      if (event.target !== viewport || !viewport.clientWidth) return;
      if (requestedScrollLeft.current !== null) {
        if (Math.abs(viewport.scrollLeft - requestedScrollLeft.current) > 1) return;
        requestedScrollLeft.current = null;
        return;
      }
      const frame = viewport.getBoundingClientRect();
      const panes = [...viewport.querySelectorAll<HTMLElement>('[data-chat-pane-mount]')];
      // Prefer the active pane on a tie, so scrolling with two visible panes does not steal focus.
      panes.sort((a, b) => Number(b.dataset.chatPaneMount === latest.current.activePaneId)
        - Number(a.dataset.chatPaneMount === latest.current.activePaneId));
      let best: HTMLElement | undefined;
      let visibleWidth = 0;
      for (const pane of panes) {
        const bounds = pane.getBoundingClientRect();
        const visible = Math.max(0, Math.min(bounds.right, frame.left + viewport.clientWidth) - Math.max(bounds.left, frame.left));
        if (visible > visibleWidth + 1) { best = pane; visibleWidth = visible; }
      }
      const id = best?.dataset.chatPaneMount;
      if (id && id !== latest.current.activePaneId) {
        scrollSelectedPane.current = id;
        latest.current.onSelectPane(id);
      }
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaX !== 0 && !event.ctrlKey && !event.metaKey && !event.altKey) requestedScrollLeft.current = null;
    };
    viewport.addEventListener('scrollend', settled);
    viewport.addEventListener('wheel', wheel, { passive: true });
    const observer = new viewport.ownerDocument.defaultView!.ResizeObserver(() => revealRef.current('instant'));
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scrollend', settled);
      viewport.removeEventListener('wheel', wheel);
    };
  }, []);

  useLayoutEffect(() => {
    if (scrollSelectedPane.current === activePaneId) { scrollSelectedPane.current = null; return; }
    scrollSelectedPane.current = null;
    const view = viewportRef.current?.ownerDocument.defaultView;
    const reduceMotion = view?.matchMedia('(prefers-reduced-motion: reduce)').matches;
    revealRef.current(reduceMotion ? 'instant' : 'smooth');
  }, [activePaneId, layoutProps.layout]);

  return <div className={styles.split} ref={scrollbarsRef}>
    <div className={styles.paneViewport} ref={viewportRef} aria-label="Chat panes">
      <div className={styles.paneTrack} style={{ minWidth: splitPaneMinimumWidth(layoutProps.layout, CHAT_PANE_MIN_WIDTH) }}>
        <SplitPaneLayout {...layoutProps} minimumPaneWidth={CHAT_PANE_MIN_WIDTH} resizeLabel="Resize chat panes" />
      </div>
    </div>
  </div>;
}
