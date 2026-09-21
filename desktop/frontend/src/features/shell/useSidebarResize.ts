import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';

type Side = 'left' | 'right';
type Widths = Record<Side, number | null>;

export function sidebarWidths(available: number, base: number, preferred: Widths, rightOpen: boolean, reviewing: boolean) {
  // At the default 320px token, sidebars range from 200px to 640px.
  const minimum = base * 0.625;
  const maximum = base * 2;
  const centerMinimum = base * (reviewing ? 2 : 1);
  const budget = Math.max(minimum * (rightOpen ? 2 : 1), available - centerMinimum);
  const clamp = (value: number) => Math.min(maximum, Math.max(minimum, value));
  let left = clamp(preferred.left ?? base);
  let right = clamp(preferred.right ?? base);
  if (rightOpen && left + right > budget) {
    const extra = left + right - 2 * minimum;
    const scale = extra > 0 ? Math.max(0, budget - 2 * minimum) / extra : 0;
    left = minimum + (left - minimum) * scale;
    right = minimum + (right - minimum) * scale;
  } else if (!rightOpen) left = Math.min(left, budget);
  return { left, right, minimum,
    leftMaximum: Math.max(minimum, Math.min(maximum, budget - (rightOpen ? right : 0))),
    rightMaximum: Math.max(minimum, Math.min(maximum, budget - left)),
  };
}

export function useSidebarResize({ rightOpen, reviewing, disabled }: {
  rightOpen: boolean; reviewing: boolean; disabled: boolean;
}) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState<Widths>({ left: null, right: null });
  const [size, setSize] = useState({ available: 0, base: 0 });
  const [resizing, setResizing] = useState<Side | null>(null);
  const drag = useRef<{ side: Side; id: number; x: number; width: number; previous: number | null; target: HTMLElement } | null>(null);
  const widths = sidebarWidths(size.available, size.base, preferred, rightOpen, reviewing);

  useLayoutEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const measure = () => {
      const base = Number.parseFloat(getComputedStyle(layout).getPropertyValue('--sidebar-width'));
      if (!Number.isFinite(base) || base <= 0) return;
      const available = layout.getBoundingClientRect().width;
      setSize(previous => previous.base === base && previous.available === available ? previous : { base, available });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);

  const finishDrag = (restore: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (restore) setPreferred(value => ({ ...value, [current.side]: current.previous }));
    setResizing(null);
    if (current.target.hasPointerCapture(current.id)) current.target.releasePointerCapture(current.id);
  };

  useLayoutEffect(() => {
    // Closing a panel or opening a modal must not leave a captured pointer behind.
    if (disabled || (drag.current?.side === 'right' && !rightOpen)) finishDrag(true);
  }, [disabled, rightOpen]);

  useLayoutEffect(() => () => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.id)) current.target.releasePointerCapture(current.id);
  }, []);

  const separatorProps = (side: Side): HTMLAttributes<HTMLDivElement> => {
    const enabled = !disabled && (side === 'left' || rightOpen) && size.base > 0;
    const maximum = side === 'left' ? widths.leftMaximum : widths.rightMaximum;
    const apply = (width: number) => setPreferred(value => ({ ...value,
      [side]: Math.min(maximum, Math.max(widths.minimum, width)),
    }));
    const move = (x: number) => {
      const current = drag.current;
      if (current?.side === side) apply(current.width + (x - current.x) * (side === 'left' ? 1 : -1));
    };
    return {
      role: 'separator', tabIndex: enabled ? 0 : -1,
      'aria-label': `Resize ${side} sidebar`, 'aria-orientation': 'vertical',
      'aria-disabled': !enabled,
      'aria-valuemin': Math.round(widths.minimum), 'aria-valuemax': Math.round(maximum),
      'aria-valuenow': Math.round(widths[side]), 'aria-valuetext': `${Math.round(widths[side])} pixels`,
      title: `Drag to resize the ${side} sidebar; double-click to reset`,
      onPointerDown(event) {
        if (!enabled || event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.stopPropagation();
        drag.current = { side, id: event.pointerId, x: event.clientX, width: widths[side],
          previous: preferred[side], target: event.currentTarget };
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizing(side);
      },
      onPointerMove(event) {
        if (drag.current?.side !== side || drag.current.id !== event.pointerId) return;
        event.preventDefault();
        move(event.clientX);
      },
      onPointerUp(event) {
        if (drag.current?.side !== side || drag.current.id !== event.pointerId) return;
        move(event.clientX);
        finishDrag(false);
      },
      onPointerCancel(event) { if (drag.current?.id === event.pointerId) finishDrag(true); },
      onLostPointerCapture(event) { if (drag.current?.id === event.pointerId) finishDrag(true); },
      onDoubleClick(event) {
        if (!enabled) return;
        event.preventDefault();
        event.stopPropagation();
        setPreferred(value => ({ ...value, [side]: null }));
      },
      onKeyDown(event) {
        if (!enabled) return;
        let next: number;
        const step = event.shiftKey ? 40 : 10;
        switch (event.key) {
          case 'ArrowLeft': next = widths[side] + (side === 'left' ? -step : step); break;
          case 'ArrowRight': next = widths[side] + (side === 'left' ? step : -step); break;
          case 'Home': next = widths.minimum; break;
          case 'End': next = maximum; break;
          default: return;
        }
        event.preventDefault();
        event.stopPropagation();
        apply(next);
      },
    };
  };

  return { layoutRef, resizing, separatorProps,
    style: (size.base > 0 ? { '--left-sidebar-width': `${widths.left}px`, '--right-sidebar-width': `${widths.right}px` } : {}) as CSSProperties,
  };
}
