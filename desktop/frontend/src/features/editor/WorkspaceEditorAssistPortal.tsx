import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Keep the assistant outside the blurred scene while following its editor pane. */
export function WorkspaceEditorAssistPortal({ children }: { children: ReactNode }) {
  const boundsRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const bounds = boundsRef.current, portal = portalRef.current;
    const view = bounds?.ownerDocument.defaultView;
    if (!bounds || !portal || !view) return;
    let frame = 0;
    let previous = '';
    const followPane = () => {
      const rect = bounds.getBoundingClientRect();
      const hidden = !bounds.isConnected || !bounds.getClientRects().length
        || !!bounds.closest('[hidden], [inert]') || view.getComputedStyle(bounds).visibility === 'hidden';
      const geometry = `${rect.x},${rect.y},${rect.width},${rect.height},${hidden}`;
      if (geometry !== previous) {
        previous = geometry;
        portal.hidden = hidden;
        Object.assign(portal.style, {
          left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`,
        });
      }
      // Split panes can move or animate without changing their own size.
      frame = view.requestAnimationFrame(followPane);
    };
    followPane();
    return () => view.cancelAnimationFrame(frame);
  }, []);

  return <>
    <div ref={boundsRef} className="workspace-editor-assist-bounds" aria-hidden="true" />
    {createPortal(<div ref={portalRef} className="workspace-editor-assist-portal">{children}</div>, document.body)}
  </>;
}
