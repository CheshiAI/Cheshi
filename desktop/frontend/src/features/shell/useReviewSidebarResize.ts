import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';

const MIN_PANE_WIDTH = 320;
const DEFAULT_RATIO = 0.5;
const KEYBOARD_STEP = 0.05;

function ratioLimits(width: number) {
  const minimum = width > 0 ? Math.min(0.5, MIN_PANE_WIDTH / width) : 0.1;
  return { minimum, maximum: 1 - minimum };
}

export function useReviewSidebarResize(enabled: boolean, panelName: string) {
  const slotRef = useRef<HTMLElement>(null);
  const [preferredRatio, setPreferredRatio] = useState(DEFAULT_RATIO);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ id: number; x: number; width: number; previous: number } | null>(null);
  const { minimum, maximum } = ratioLimits(availableWidth);
  const ratio = Math.min(maximum, Math.max(minimum, preferredRatio));

  useLayoutEffect(() => {
    if (!enabled) {
      drag.current = null;
      setResizing(false);
      return;
    }
    const slot = slotRef.current;
    const layout = slot?.parentElement;
    const workspace = layout?.querySelector<HTMLElement>(':scope > .workspace-column');
    if (!layout || !workspace) return;
    const measure = () => setAvailableWidth(Math.max(0,
      layout.getBoundingClientRect().right - workspace.getBoundingClientRect().left));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [enabled]);

  const apply = (next: number) => setPreferredRatio(Math.min(maximum, Math.max(minimum, next)));
  const resizeAt = (x: number) => {
    if (!drag.current || availableWidth <= 0) return;
    apply((drag.current.width + drag.current.x - x) / availableWidth);
  };
  const cancel = (pointerId: number) => {
    if (drag.current?.id !== pointerId) return;
    setPreferredRatio(drag.current.previous);
    drag.current = null;
    setResizing(false);
  };
  const separatorProps: HTMLAttributes<HTMLDivElement> = {
    role: 'separator',
    tabIndex: 0,
    'aria-label': `Resize ${panelName} panel`,
    'aria-orientation': 'vertical',
    'aria-valuemin': Math.round(minimum * 100),
    'aria-valuemax': Math.round(maximum * 100),
    'aria-valuenow': Math.round(ratio * 100),
    'aria-valuetext': `${Math.round(ratio * 100)}% for the ${panelName} panel`,
    title: `Drag to resize the ${panelName} panel; double-click to reset`,
    onPointerDown(event) {
      if (!enabled || event.button !== 0 || availableWidth <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      drag.current = { id: event.pointerId, x: event.clientX,
        width: slotRef.current?.getBoundingClientRect().width ?? ratio * availableWidth,
        previous: preferredRatio };
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizing(true);
    },
    onPointerMove(event) {
      if (drag.current?.id !== event.pointerId) return;
      event.preventDefault();
      resizeAt(event.clientX);
    },
    onPointerUp(event) {
      if (drag.current?.id !== event.pointerId) return;
      event.preventDefault();
      resizeAt(event.clientX);
      drag.current = null;
      setResizing(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel(event) { cancel(event.pointerId); },
    onLostPointerCapture(event) { cancel(event.pointerId); },
    onDoubleClick(event) {
      event.preventDefault();
      event.stopPropagation();
      setPreferredRatio(DEFAULT_RATIO);
    },
    onKeyDown(event) {
      let next: number;
      switch (event.key) {
        case 'ArrowLeft': next = ratio + KEYBOARD_STEP; break;
        case 'ArrowRight': next = ratio - KEYBOARD_STEP; break;
        case 'Home': next = minimum; break;
        case 'End': next = maximum; break;
        default: return;
      }
      event.preventDefault();
      event.stopPropagation();
      apply(next);
    },
  };

  return {
    slotRef,
    resizing: enabled && resizing,
    separatorProps,
    style: { '--review-ratio': ratio } as CSSProperties,
  };
}
