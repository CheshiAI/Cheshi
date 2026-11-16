/** Continue horizontal gestures from the embedded layer tree into the host's sidebar tabs. */
export function connectCanvasSidebarSwipe(frame: HTMLIFrameElement, layers: HTMLElement) {
  const viewport = layers.closest<HTMLElement>('[data-sidebar-tab-viewport]');
  const view = layers.ownerDocument.defaultView;
  if (!viewport || !view) return () => {};
  let document: Document | null = null;
  let timer: number | undefined;
  let originalSnap: string | null = null;
  const restoreSnap = () => {
    view.clearTimeout(timer);
    timer = undefined;
    if (originalSnap === null) return;
    viewport.style.scrollSnapType = originalSnap;
    originalSnap = null;
  };
  const settle = () => {
    const width = viewport.clientWidth;
    const left = width ? Math.round(viewport.scrollLeft / width) * width : 0;
    restoreSnap();
    viewport.scrollTo({ left, behavior: view.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  const wheel = (event: WheelEvent) => {
    const target = event.target;
    if (!document?.defaultView || !(target instanceof document.defaultView.Element)
      || !target.closest('.cheshi-docked-layers') || layers.closest('[inert], [aria-hidden="true"]')
      || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const delta = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
    if (!delta || (!event.shiftKey && Math.abs(delta) <= Math.abs(event.deltaY))) return;
    const unit = event.deltaMode === 1 ? Number.parseFloat(view.getComputedStyle(viewport).lineHeight) || 16
      : event.deltaMode === 2 ? viewport.clientWidth : 1;
    // Notify the shared tabs that this is a user gesture, interrupting pending tab clicks.
    if (!viewport.dispatchEvent(new view.WheelEvent('wheel', {
      deltaX: delta * unit, bubbles: true, cancelable: true,
    }))) return;
    event.preventDefault();
    if (originalSnap === null) {
      originalSnap = viewport.style.scrollSnapType;
      viewport.style.scrollSnapType = 'none';
    }
    viewport.scrollBy({ left: delta * unit, behavior: 'instant' });
    view.clearTimeout(timer);
    timer = view.setTimeout(settle, 160);
  };
  const attach = () => {
    document?.removeEventListener('wheel', wheel);
    document?.removeEventListener('pointerdown', restoreSnap);
    document = frame.contentDocument;
    document?.addEventListener('wheel', wheel, { passive: false });
    document?.addEventListener('pointerdown', restoreSnap);
  };
  // Once the pointer is over host content again, native input owns the gesture.
  const nativeWheel = (event: WheelEvent) => { if (event.isTrusted) restoreSnap(); };
  viewport.addEventListener('wheel', nativeWheel, { passive: true });
  const root = viewport.parentElement;
  root?.addEventListener('pointerdown', restoreSnap, true);
  frame.addEventListener('load', attach);
  attach();
  return () => {
    restoreSnap();
    document?.removeEventListener('wheel', wheel);
    document?.removeEventListener('pointerdown', restoreSnap);
    viewport.removeEventListener('wheel', nativeWheel);
    root?.removeEventListener('pointerdown', restoreSnap, true);
    frame.removeEventListener('load', attach);
  };
}
