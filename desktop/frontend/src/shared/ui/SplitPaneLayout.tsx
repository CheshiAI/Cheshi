import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  collapsedPane?: 'first' | 'second' | null;
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

function splitGridStyle(axis: SplitLayout['axis'], ratio: number): CSSProperties {
  const first = `minmax(0, ${ratio}fr)`;
  const second = `minmax(0, ${1 - ratio}fr)`;
  return axis === 'columns'
    ? { gridTemplateColumns: `${first} ${SPLIT_SEPARATOR_TRACK_SIZE}px ${second}` }
    : { gridTemplateRows: `${first} ${SPLIT_SEPARATOR_TRACK_SIZE}px ${second}` };
}

function Split({
  layout,
  renderPane,
  onResizeSplit,
  resizeLabel = 'Resize panes',
  collapsedPane,
}: SplitProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstRegionRef = useRef<HTMLDivElement | null>(null);
  const secondRegionRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const ratioRef = useRef(layout.ratio);
  const [ratio, setRatio] = useState(layout.ratio);
  const [dragging, setDragging] = useState(false);
  ratioRef.current = ratio;

  useEffect(() => {
    if (pointerIdRef.current === null) setRatio(layout.ratio);
  }, [layout.ratio]);

  useLayoutEffect(() => {
    const first = firstRegionRef.current;
    const second = secondRegionRef.current;
    if (!first || !second) return;

    // Enable the destination before moving focus, including when switching collapsed sides.
    if (collapsedPane !== 'first') first.removeAttribute('inert');
    if (collapsedPane !== 'second') second.removeAttribute('inert');
    const closing = collapsedPane === 'first' ? first : collapsedPane === 'second' ? second : null;
    const visible = collapsedPane === 'first' ? second : first;
    if (closing?.contains(closing.ownerDocument.activeElement)) {
      visible.focus({ preventScroll: true });
    }
    // Applying inert earlier can blur the focused descendant before we can transfer focus.
    first.toggleAttribute('inert', collapsedPane === 'first');
    second.toggleAttribute('inert', collapsedPane === 'second');
  }, [collapsedPane]);

  const availableSize = useCallback((): number => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return 0;
    const size = layout.axis === 'columns' ? bounds.width : bounds.height;
    return Math.max(0, size - SPLIT_SEPARATOR_TRACK_SIZE);
  }, [layout.axis]);

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
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    applyRatio(ratioFromPointer(event.clientX, event.clientY));
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    applyRatio(ratioFromPointer(event.clientX, event.clientY));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointerIdRef.current !== event.pointerId) return;
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
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    setDragging(false);
    setRatio(layout.ratio);
  };

  const handleLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointerIdRef.current !== event.pointerId) return;
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
      data-collapsible={collapsedPane !== undefined ? 'true' : undefined}
      style={collapsedPane ? {
        [layout.axis === 'columns' ? 'gridTemplateColumns' : 'gridTemplateRows']:
          collapsedPane === 'first' ? 'minmax(0, 0fr) 0px minmax(0, 1fr)' : 'minmax(0, 1fr) 0px minmax(0, 0fr)',
      } : splitGridStyle(layout.axis, ratio)}
    >
      <div ref={firstRegionRef} className={styles.region} tabIndex={-1}
        data-collapsed={collapsedPane === 'first' ? 'true' : undefined}>
        <SplitPaneLayout
          layout={layout.first}
          renderPane={renderPane}
          onResizeSplit={onResizeSplit}
          resizeLabel={resizeLabel}
        />
      </div>
      <div
        className={styles.separator}
        role="separator"
        hidden={!!collapsedPane}
        tabIndex={0}
        aria-label={resizeLabel}
        aria-orientation={layout.axis === 'columns' ? 'vertical' : 'horizontal'}
        aria-valuemin={MIN_SPLIT_RATIO * 100}
        aria-valuemax={MAX_SPLIT_RATIO * 100}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={`${Math.round(ratio * 100)}% for the first pane`}
        title={`${resizeLabel}; double-click to reset`}
        onDoubleClick={resetRatio}
        onKeyDown={handleKeyDown}
        onLostPointerCapture={handleLostPointerCapture}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
      <div ref={secondRegionRef} className={styles.region} tabIndex={-1}
        data-collapsed={collapsedPane === 'second' ? 'true' : undefined}>
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
