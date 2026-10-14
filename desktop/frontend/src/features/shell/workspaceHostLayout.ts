import type { WorkspaceHostApi } from '../../../../shared/workspace-host';

/** Report chrome geometry; the native host handles live window resizing. */
export function observeWorkspaceHostLayout(element: HTMLElement, layout: WorkspaceHostApi['layout'], onError: (error: unknown) => void) {
  let disposed = false;
  let previous = '';
  const flush = () => {
    if (disposed) return;
    const { x, y, width, height } = element.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const bounds = { x, y, width, height, viewport }, key = JSON.stringify(bounds);
    if (previous === key) return;
    previous = key;
    void layout(bounds).catch(error => {
      if (previous === key) previous = '';
      if (!disposed) onError(error);
    });
  };
  // The observer already reports layout changes; another resize listener would
  // send the same bounds twice, and waiting for IPC replies can stall live zoom.
  const observer = new ResizeObserver(flush);
  observer.observe(element);
  flush();
  return () => {
    disposed = true;
    observer.disconnect();
  };
}
