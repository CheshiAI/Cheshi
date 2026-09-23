import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const GESTURE_GAP_MS = 220;
const SETTLE_DELAY_MS = 64;
const DIRECTION_THRESHOLD_PX = 8;
const AXIS_CHANGE_THRESHOLD_PX = 16;

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
    let resumeShortSwipe = false;
    let offset = 0;
    let resumeIntent = 0;
    let horizontalIntent = 0;
    let inputDirection = 0;
    let motionTime = -Infinity;
    let motionDirection = 0;
    let motionDistance = 0;
    let velocity = 0;
    const width = () => strip.clientWidth;
    const gestureDirection = () => inputDirection || Math.sign(x || intentX);
    const visibleDistance = () => {
      const transform = view.getComputedStyle(strip).transform;
      const matrix = transform.match(/^matrix\(([^)]+)\)$/)?.[1]?.split(',').map(Number);
      const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/)?.[1]?.split(',').map(Number);
      const translation = matrix?.[4] ?? matrix3d?.[12];
      return translation !== undefined && Number.isFinite(translation)
        ? -(translation + current.current.index * width()) : 0;
    };
    const resetMotion = () => {
      motionTime = -Infinity;
      motionDirection = motionDistance = velocity = 0;
    };
    const recordMotion = (distance: number, time: number) => {
      const elapsed = time - motionTime;
      const direction = Math.sign(distance);
      if (direction && direction === motionDirection && elapsed > 0 && elapsed <= 80) {
        velocity = velocity * .3 + distance / elapsed * .7;
        motionDistance += Math.abs(distance);
      } else {
        velocity = 0;
        motionDistance = Math.abs(distance);
      }
      motionDirection = direction;
      motionTime = time;
    };
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
      resumeIntent = horizontalIntent = inputDirection = 0;
      resetMotion();
      strip.style.removeProperty('--sidebar-swipe-duration');
      axis = '';
      settled = false;
      resumeShortSwipe = false;
      setPreviewIndex(null);
    };
    cancel.current = () => {
      settledDirection = gestureDirection();
      reset();
      settled = true;
    };
    const settle = () => {
      const { index: base, ids: panels, onSelect: select } = current.current;
      const panelWidth = width();
      // Only sustained, recent movement may project a short flick past the midpoint.
      // Slow travel, a single wheel event and clamped edge input use distance alone.
      const flick = motionDistance >= Math.min(48, panelWidth * .15) && Math.abs(velocity) >= .45;
      const destination = x + (flick ? velocity * 180 : 0);
      const next = nearestPanelIndex(base, destination, panelWidth, panels.length);
      const remaining = Math.abs((next - base) * panelWidth - x);
      const duration = remaining < 1 ? 0 : Math.round(Math.max(80, Math.min(240, remaining / (.8 + Math.abs(velocity)))));
      strip.style.setProperty('--sidebar-swipe-duration', `${duration}ms`);
      settledDirection = next === base ? gestureDirection() : Math.sign(next - base);
      resumeShortSwipe = next === base && Math.abs(x) > 0;
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
      let dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      const horizontal = Math.abs(dx) > Math.abs(dy) * 1.4;
      const quiet = event.timeStamp - last > GESTURE_GAP_MS;
      if (quiet) resumeIntent = 0;
      if (settled && horizontal && (Math.sign(dx) !== settledDirection || resumeShortSwipe)) {
        resumeIntent = Math.sign(resumeIntent) === Math.sign(dx) ? resumeIntent + dx : dx;
      } else resumeIntent = 0;
      const resuming = Math.abs(resumeIntent) >= DIRECTION_THRESHOLD_PX;
      if (quiet || resuming) {
        // Read the animated position before resetting any styles, then preserve
        // all small reverse inputs that established the new gesture.
        const visible = visibleDistance();
        const movement = resuming ? resumeIntent : dx;
        reset();
        x = visible;
        dx = movement;
      }
      last = event.timeStamp;
      if (settled) {
        // Vertical scrolling starts a new axis decision, independently of the
        // cursor position or the preceding horizontal momentum guard.
        if (Math.abs(dy) >= DIRECTION_THRESHOLD_PX && !horizontal) {
          reset();
          axis = 'vertical';
          return;
        }
        if (Math.abs(dx) > Math.abs(dy)) event.preventDefault();
        return;
      }
      if (axis === 'vertical') {
        horizontalIntent = horizontal
          ? (Math.sign(horizontalIntent) === Math.sign(dx) ? horizontalIntent + dx : dx) : 0;
        if (Math.abs(horizontalIntent) < AXIS_CHANGE_THRESHOLD_PX) return;
        // Discard horizontal drift collected during vertical scrolling. A new
        // horizontal run can take over without waiting for complete silence.
        x = visibleDistance();
        dx = horizontalIntent;
        intentX = y = 0;
        axis = 'horizontal';
        resetMotion();
      }
      // Clamp to existing neighbors so edge input cannot build up hidden travel
      // that would delay a reversal, including during the momentum tail.
      const minimumX = base > 0 ? -panelWidth : 0;
      const maximumX = base < panels.length - 1 ? panelWidth : 0;
      const previousX = x;
      x = Math.max(minimumX, Math.min(maximumX, x + dx));
      intentX += dx;
      y += dy;
      if (!axis && Math.max(Math.abs(intentX), Math.abs(y)) >= DIRECTION_THRESHOLD_PX) {
        if (Math.abs(intentX) > Math.abs(y) * 1.4) axis = 'horizontal';
        else if (Math.abs(y) >= Math.abs(intentX)) axis = 'vertical';
      }
      if (axis !== 'horizontal') return;
      event.preventDefault();
      inputDirection = Math.sign(dx) || inputDirection;
      recordMotion(x - previousX, event.timeStamp);
      offset = -x;
      if (!element.hasAttribute('data-swiping')) {
        element.setAttribute('data-swiping', 'true');
        strip.style.setProperty('--sidebar-swipe-offset', `${offset}px`);
      }
      if (!frame) frame = view.requestAnimationFrame(paint);
      view.clearTimeout(timer);
      // Wheel events have no portable gesture-end signal; settle after a short quiet interval.
      timer = view.setTimeout(settle, SETTLE_DELAY_MS);
    };
    // Capture the entire surface, including blank space; consume only horizontal gestures.
    element.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      restore();
      strip.style.removeProperty('--sidebar-swipe-duration');
      cancel.current = () => {};
      element.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, []);

  return { surface, track, previewIndex, cancelSwipe: () => cancel.current() };
}
