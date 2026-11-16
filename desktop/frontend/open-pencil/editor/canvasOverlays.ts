import type { CanvasRectangle } from '../../../shared/canvas-layout';

/** Let page/layer menus extend above a short dock without covering the file list when closed. */
export function connectCanvasOverlays(post: (message: object) => void) {
  let frame = 0;
  let previous = '';
  const update = () => {
    frame = 0;
    const rectangles: CanvasRectangle[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"], [role="dialog"], [role="tooltip"]')) {
      if (element.dataset.state === 'closed' || !element.checkVisibility()) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const x = Math.max(0, rect.x - 8), y = Math.max(0, rect.y - 8);
      const width = Math.min(innerWidth, rect.right + 8) - x;
      const height = Math.min(innerHeight, rect.bottom + 8) - y;
      if (width > 0 && height > 0) rectangles.push({ x, y, width, height });
    }
    const serialized = JSON.stringify(rectangles);
    if (serialized !== previous) { previous = serialized; post({ type: 'overlays', payload: rectangles }); }
    // Popup positioning and entry animations can change their bounds without a DOM mutation.
    if (rectangles.length) frame = requestAnimationFrame(update);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'data-state'] });
  schedule();
  return () => { observer.disconnect(); cancelAnimationFrame(frame); };
}
