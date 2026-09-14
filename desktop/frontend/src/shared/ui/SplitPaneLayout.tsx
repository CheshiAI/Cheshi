import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { SplitLayoutNode } from './splitPaneModel';
import styles from './SplitPaneLayout.module.css';

const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;
const MIN_PANE_SIZE = 120;
const SPLIT_SEPARATOR_TRACK_SIZE = 1;
const KEYBOARD_RATIO_STEP = 0.05;

type SplitLayout = Extract<SplitLayoutNode, { type: 'split' }>;

export interface SplitPaneLayoutProps {
  layout: SplitLayoutNode;
  renderPane: (paneId: string) => ReactNode;
  onResizeSplit: (splitId: string, ratio: number) => void;
  resizeLabel?: string;
  /** Collapse only this split, preserving mounted descendants and the saved ratio. */
  collapsedPane?: 'first' | 'second';
}

interface SplitProps extends Omit<SplitPaneLayoutProps, 'layout'> {
  layout: SplitLayout;
}

function clampSplitRatio(ratio: number, availableSize: number): number {
  const minimum = availableSize > 0
    ? Math.min(0.5, Math.max(MIN_SPLIT_RATIO, MIN_PANE_SIZE / availableSize))
    : MIN_SPLIT_RATIO;
  return Math.min(1 - minimum, Math.max(minimum, ratio));
}

function splitGridStyle(
  axis: SplitLayout['axis'], ratio: number, collapsedPane: SplitPaneLayoutProps['collapsedPane'],
): CSSProperties {
  const visibleRatio = collapsedPane === 'first' ? 0 : collapsedPane === 'second' ? 1 : ratio;
  const separatorSize = collapsedPane ? 0 : SPLIT_SEPARATOR_TRACK_SIZE;
  const first = `minmax(0, ${visibleRatio}fr)`;
  const second = `minmax(0, ${1 - visibleRatio}fr)`;
  return axis === 'columns'
    ? { gridTemplateColumns: `${first} ${separatorSize}px ${second}` }
    : { gridTemplateRows: `${first} ${separatorSize}px ${second}` };
}

function Split({
  layout,
  renderPane,
  onResizeSplit,
  resizeLabel = 'Resize panes',
  collapsedPane,
}: SplitProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const separatorRef = useRef<HTMLDivElement | null>(null);
  const hasCollapsedRef = useRef(false);
  if (collapsedPane) hasCollapsedRef.current = true;
  const pointerIdRef = useRef<number | null>(null);
  const ratioRef = useRef(layout.ratio);
  const [ratio, setRatio] = useState(layout.ratio);
  const [dragging, setDragging] = useState(false);
  const [containerSize, setContainerSize] = useState(0);
  // Keep the saved preference intact when a smaller window temporarily limits the panes.
  const visibleRatio = clampSplitRatio(ratio, containerSize);
  ratioRef.current = visibleRatio;

  useEffect(() => {
    if (pointerIdRef.current === null) setRatio(layout.ratio);
  }, [layout.ratio]);

  useEffect(() => {
    if (!collapsedPane || pointerIdRef.current === null) return;
    const pointerId = pointerIdRef.current;
    pointerIdRef.current = null;
    if (separatorRef.current?.hasPointerCapture(pointerId)) {
      separatorRef.current.releasePointerCapture(pointerId);
    }
    setDragging(false);
    setRatio(layout.ratio);
  }, [collapsedPane, layout.ratio]);

  const availableSize = useCallback((): number => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return 0;
    const size = layout.axis === 'columns' ? bounds.width : bounds.height;
    return Math.max(0, size - SPLIT_SEPARATOR_TRACK_SIZE);
  }, [layout.axis]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => setContainerSize(availableSize());
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [availableSize]);

  const ratioFromPointer = useCallback((clientX: number, clientY: number): number => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return ratioRef.current;
    const size = Math.max(
      0,
      (layout.axis === 'columns' ? bounds.width : bounds.height) - SPLIT_SEPARATOR_TRACK_SIZE,
    );
    if (size === 0) return ratioRef.current;
    const offset = layout.axis === 'columns'
      ? clientX - bounds.left - SPLIT_SEPARATOR_TRACK_SIZE / 2
      : clientY - bounds.top - SPLIT_SEPARATOR_TRACK_SIZE / 2;
    return clampSplitRatio(offset / size, size);
  }, [layout.axis]);

  const applyRatio = useCallback((nextRatio: number): void => {
    ratioRef.current = nextRatio;
    setRatio(nextRatio);
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (collapsedPane || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    applyRatio(ratioFromPointer(event.clientX, event.clientY));
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (collapsedPane || pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    applyRatio(ratioFromPointer(event.clientX, event.clientY));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (collapsedPane || pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    applyRatio(ratioFromPointer(event.clientX, event.clientY));
    pointerIdRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResizeSplit(layout.id, ratioRef.current);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (collapsedPane || pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    setDragging(false);
    setRatio(layout.ratio);
  };

  const handleLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (collapsedPane || pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    setDragging(false);
    setRatio(layout.ratio);
  };

  const commitKeyboardRatio = (nextRatio: number): void => {
    const clamped = clampSplitRatio(nextRatio, availableSize());
    applyRatio(clamped);
    onResizeSplit(layout.id, clamped);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (collapsedPane) return;
    let nextRatio: number | null = null;
    if (layout.axis === 'columns') {
      if (event.key === 'ArrowLeft') nextRatio = ratioRef.current - KEYBOARD_RATIO_STEP;
      if (event.key === 'ArrowRight') nextRatio = ratioRef.current + KEYBOARD_RATIO_STEP;
    } else {
      if (event.key === 'ArrowUp') nextRatio = ratioRef.current - KEYBOARD_RATIO_STEP;
      if (event.key === 'ArrowDown') nextRatio = ratioRef.current + KEYBOARD_RATIO_STEP;
    }
    if (event.key === 'Home') nextRatio = MIN_SPLIT_RATIO;
    if (event.key === 'End') nextRatio = MAX_SPLIT_RATIO;
    if (nextRatio === null) return;
    event.preventDefault();
    event.stopPropagation();
    commitKeyboardRatio(nextRatio);
  };

  const resetRatio = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (collapsedPane) return;
    event.preventDefault();
    event.stopPropagation();
    commitKeyboardRatio(0.5);
  };

  return (
    <div
      ref={containerRef}
      className={styles.split}
      data-axis={layout.axis}
      data-dragging={dragging ? 'true' : undefined}
      data-collapsible={hasCollapsedRef.current ? 'true' : undefined}
      data-collapsed-pane={collapsedPane}
      style={splitGridStyle(layout.axis, visibleRatio, collapsedPane)}
    >
      <div className={styles.region} data-pane="first" aria-hidden={collapsedPane === 'first' || undefined} inert={collapsedPane === 'first'}>
        <SplitPaneLayout
          layout={layout.first}
          renderPane={renderPane}
          onResizeSplit={onResizeSplit}
          resizeLabel={resizeLabel}
        />
      </div>
      <div
        ref={separatorRef}
        className={styles.separator}
        aria-hidden={collapsedPane ? true : undefined}
        inert={!!collapsedPane}
        role="separator"
        tabIndex={collapsedPane ? -1 : 0}
        aria-label={resizeLabel}
        aria-orientation={layout.axis === 'columns' ? 'vertical' : 'horizontal'}
        aria-valuemin={MIN_SPLIT_RATIO * 100}
        aria-valuemax={MAX_SPLIT_RATIO * 100}
        aria-valuenow={Math.round(visibleRatio * 100)}
        aria-valuetext={`${Math.round(visibleRatio * 100)}% for the first pane`}
        title={`${resizeLabel}; double-click to reset`}
        onDoubleClick={resetRatio}
        onKeyDown={handleKeyDown}
        onLostPointerCapture={handleLostPointerCapture}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
      <div className={styles.region} data-pane="second" aria-hidden={collapsedPane === 'second' || undefined} inert={collapsedPane === 'second'}>
        <SplitPaneLayout
          layout={layout.second}
          renderPane={renderPane}
          onResizeSplit={onResizeSplit}
          resizeLabel={resizeLabel}
        />
      </div>
    </div>
  );
}

/** Leaves may remount after a structural edit; keep persistent pane state outside this tree. */
export function SplitPaneLayout(props: SplitPaneLayoutProps) {
  return props.layout.type === 'split'
    ? <Split key={props.layout.id} {...props} layout={props.layout} />
    : <>{props.renderPane(props.layout.paneId)}</>;
}
