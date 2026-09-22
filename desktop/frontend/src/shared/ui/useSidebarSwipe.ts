import { useEffect, useLayoutEffect, useRef, useState } from 'react';

function nearestPanelIndex(index: number, distance: number, width: number, count: number) {
  const direction = Math.abs(distance) >= width / 2 ? Math.sign(distance) : 0;
  return Math.max(0, Math.min(count - 1, index + direction));
}

export function useSidebarSwipe(index: number, ids: readonly string[], onSelect: (id: string) => void) {
  const surface = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const current = useRef({ index, ids, onSelect });
  const cancel = useRef(() => {});
  const expectedIndex = useRef(index);
  const panelKey = JSON.stringify(ids);
  const previousKey = useRef(panelKey);
  useLayoutEffect(() => {
    if (index !== expectedIndex.current || panelKey !== previousKey.current) cancel.current();
    current.current = { index, ids, onSelect };
    expectedIndex.current = index;
    previousKey.current = panelKey;
  });

  useEffect(() => {
    const element = surface.current;
    const strip = track.current;
    const view = element?.ownerDocument.defaultView;
    if (!element || !strip || !view) return;
    let timer = 0;
    let frame = 0;
    let x = 0;
    let intentX = 0;
    let y = 0;
    let last = -Infinity;
    let axis = '';
    let settled = false;
    let settledDirection = 0;
    let offset = 0;
    const width = () => strip.clientWidth;
    const paint = () => {
      frame = 0;
      strip.style.setProperty('--sidebar-swipe-offset', `${offset}px`);
      const { index: base, ids: panels } = current.current;
      setPreviewIndex(nearestPanelIndex(base, x, width(), panels.length));
    };
    const restore = () => {
      view.clearTimeout(timer);
      view.cancelAnimationFrame(frame);
      frame = 0;
      element.removeAttribute('data-swiping');
      strip.style.removeProperty('--sidebar-swipe-offset');
    };
    const reset = () => {
      restore();
      x = intentX = y = offset = 0;
      axis = '';
      settled = false;
      setPreviewIndex(null);
    };
    cancel.current = () => {
      settledDirection = Math.sign(x);
      reset();
      settled = true;
    };
    const settle = () => {
      const { index: base, ids: panels, onSelect: select } = current.current;
      const next = nearestPanelIndex(base, x, width(), panels.length);
      settledDirection = Math.sign(x);
      settled = true;
      restore();
      setPreviewIndex(null);
      if (next !== base && panels[next]) {
        expectedIndex.current = next;
        select(panels[next]);
      }
    };
    const onWheel = (event: WheelEvent) => {
      const { index: base, ids: panels } = current.current;
      if (panels.length < 2 || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as Element;
      if (target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
      const panelWidth = width();
      if (panelWidth <= 0) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? panelWidth : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      const quiet = event.timeStamp - last > 220;
      const reversing = settled && Math.abs(dx) >= 8 && Math.sign(dx) !== settledDirection;
      if (quiet || reversing) {
        reset();
        // Continue from the visible position if a new gesture interrupts the settling transition.
        const transform = view.getComputedStyle(strip).transform;
        const matrix = transform.match(/^matrix\(([^)]+)\)$/)?.[1]?.split(',').map(Number);
        const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/)?.[1]?.split(',').map(Number);
        const translation = matrix?.[4] ?? matrix3d?.[12];
        if (translation !== undefined && Number.isFinite(translation)) x = -(translation + base * panelWidth);
      }
      last = event.timeStamp;
      if (settled) {
        if (Math.abs(dx) > Math.abs(dy)) event.preventDefault();
        return;
      }
      // Keep one gesture within the neighboring panels, including its momentum tail.
      x = Math.max(-panelWidth, Math.min(panelWidth, x + dx));
      intentX += dx;
      y += dy;
      if (!axis && Math.max(Math.abs(intentX), Math.abs(y)) >= 8) {
        if (Math.abs(intentX) > Math.abs(y) * 1.4) axis = 'horizontal';
        else if (Math.abs(y) >= Math.abs(intentX)) axis = 'vertical';
      }
      if (axis !== 'horizontal') return;
      event.preventDefault();
      element.setAttribute('data-swiping', 'true');
      const atEdge = (base === 0 && x < 0) || (base === panels.length - 1 && x > 0);
      offset = atEdge ? -Math.sign(x) * Math.min(24, Math.abs(x) * 0.18) : -x;
      if (!frame) frame = view.requestAnimationFrame(paint);
      view.clearTimeout(timer);
      // Wheel events have no portable gesture-end signal; settle after a short quiet interval.
      timer = view.setTimeout(settle, 140);
    };
    // Capture the entire surface, including blank space; consume only horizontal gestures.
    element.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      restore();
      cancel.current = () => {};
      element.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, []);

  return { surface, track, previewIndex, cancelSwipe: () => cancel.current() };
}
