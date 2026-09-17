export interface NativeBrowserViewportRequest {
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

function displayed(element: Element): boolean {
  if (!element.isConnected || element.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
    && element.getClientRects().length > 0;
}

export function nativeBrowserViewportRequest(element: HTMLElement): NativeBrowserViewportRequest {
  const rect = element.getBoundingClientRect();
  const x = Math.max(0, rect.left);
  const y = Math.max(0, rect.top);
  const width = Math.max(0, Math.min(window.innerWidth, rect.right) - x);
  const height = Math.max(0, Math.min(window.innerHeight, rect.bottom) - y);
  const obscured = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="menu"], [role="listbox"], [popover]')]
    .some(displayed);
  return { bounds: { x, y, width, height },
    visible: document.visibilityState !== 'hidden' && displayed(element) && !obscured && width > 0 && height > 0 };
}

/** Keep native content within its renderer placeholder, including layout transitions and top-layer UI. */
export function observeNativeBrowserViewport<T extends NativeBrowserViewportRequest>(element: HTMLElement,
  createRequest: (element: HTMLElement) => T, setView: (request: T) => Promise<void>,
  onError: (error: unknown) => void): () => void {
  let disposed = false;
  let requestId = 0;
  let frame = 0;
  let transitionUntil = 0;
  let previous = '';
  let lastRequest = createRequest(element);
  const update = (): void => {
    if (disposed) return;
    const request = createRequest(element);
    const key = JSON.stringify(request);
    if (key === previous) return;
    previous = key;
    lastRequest = request;
    const id = ++requestId;
    void setView(request).catch(error => {
      if (!disposed && id === requestId) onError(error);
    });
  };
  const tick = (): void => {
    frame = 0;
    update();
    if (!disposed && performance.now() < transitionUntil) frame = window.requestAnimationFrame(tick);
  };
  const schedule = (): void => {
    if (!disposed && !frame) frame = window.requestAnimationFrame(tick);
  };
  const transition = (): void => {
    transitionUntil = performance.now() + 250;
    schedule();
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(element);
  const mutations = new MutationObserver(update);
  mutations.observe(document.body, { childList: true, subtree: true, attributes: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  document.addEventListener('visibilitychange', update);
  document.addEventListener('toggle', update, true);
  document.addEventListener('transitionrun', transition, true);
  document.addEventListener('transitionend', schedule, true);
  document.addEventListener('transitioncancel', schedule, true);
  update();
  return () => {
    disposed = true;
    requestId += 1;
    resize.disconnect();
    mutations.disconnect();
    window.cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
    document.removeEventListener('visibilitychange', update);
    document.removeEventListener('toggle', update, true);
    document.removeEventListener('transitionrun', transition, true);
    document.removeEventListener('transitionend', schedule, true);
    document.removeEventListener('transitioncancel', schedule, true);
    void setView({ ...lastRequest, visible: false }).catch(() => {});
  };
}
