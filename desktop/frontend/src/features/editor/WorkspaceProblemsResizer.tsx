import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import {
  clampProblemsRatio,
  MAX_PROBLEMS_RATIO,
  MIN_PROBLEMS_RATIO,
  PROBLEMS_RESIZER_SIZE as RESIZER_SIZE,
} from './workspaceProblemsLayout';

export const DEFAULT_WORKSPACE_PROBLEMS_RATIO = 0.25;

const KEYBOARD_RATIO_STEP = 0.05;

interface WorkspaceProblemsResizerProps {
  ratio: number;
  onRatioChange: (ratio: number) => void;
}

export function workspaceProblemsStageStyle(ratio: number, open: boolean): CSSProperties {
  const visibleRatio = open ? ratio : 0;
  return {
    gridTemplateRows: `minmax(0, ${1 - visibleRatio}fr) ${open ? RESIZER_SIZE : 0}px minmax(0, ${visibleRatio}fr)`,
  };
}

export function WorkspaceProblemsResizer({
  ratio,
  onRatioChange,
}: WorkspaceProblemsResizerProps) {
  const pointerIdRef = useRef<number | null>(null);
  const ratioRef = useRef(ratio);
  const dragStartRatioRef = useRef(ratio);
  const [dragging, setDragging] = useState(false);
  ratioRef.current = ratio;

  const availableSize = (separator: HTMLDivElement): number => {
    const bounds = separator.parentElement?.getBoundingClientRect();
    return bounds ? Math.max(0, bounds.height - RESIZER_SIZE) : 0;
  };

  const ratioFromPointer = (separator: HTMLDivElement, clientY: number): number => {
    const bounds = separator.parentElement?.getBoundingClientRect();
    if (!bounds) return ratioRef.current;
    const size = Math.max(0, bounds.height - RESIZER_SIZE);
    if (size === 0) return ratioRef.current;
    const offsetFromBottom = bounds.bottom - clientY - RESIZER_SIZE / 2;
    return clampProblemsRatio(offsetFromBottom / size, size);
  };

  const applyRatio = (nextRatio: number): void => {
    ratioRef.current = nextRatio;
    onRatioChange(nextRatio);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragStartRatioRef.current = ratioRef.current;
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    applyRatio(ratioFromPointer(event.currentTarget, event.clientY));
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    applyRatio(ratioFromPointer(event.currentTarget, event.clientY));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    applyRatio(ratioFromPointer(event.currentTarget, event.clientY));
    pointerIdRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelPointerResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    setDragging(false);
    applyRatio(dragStartRatioRef.current);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    let nextRatio: number | null = null;
    if (event.key === 'ArrowUp') nextRatio = ratioRef.current + KEYBOARD_RATIO_STEP;
    if (event.key === 'ArrowDown') nextRatio = ratioRef.current - KEYBOARD_RATIO_STEP;
    if (event.key === 'Home') nextRatio = MIN_PROBLEMS_RATIO;
    if (event.key === 'End') nextRatio = MAX_PROBLEMS_RATIO;
    if (nextRatio === null) return;
    event.preventDefault();
    event.stopPropagation();
    applyRatio(clampProblemsRatio(nextRatio, availableSize(event.currentTarget)));
  };

  const resetRatio = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    applyRatio(clampProblemsRatio(
      DEFAULT_WORKSPACE_PROBLEMS_RATIO,
      availableSize(event.currentTarget),
    ));
  };

  return (
    <div
      className="workspace-editor-problems-resizer"
      data-dragging={dragging ? 'true' : undefined}
      role="separator"
      tabIndex={0}
      aria-controls="workspace-editor-problems"
      aria-label="Resize Problems panel"
      aria-orientation="horizontal"
      aria-valuemin={MIN_PROBLEMS_RATIO * 100}
      aria-valuemax={MAX_PROBLEMS_RATIO * 100}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={`${Math.round(ratio * 100)}% for the Problems panel`}
      title="Drag to resize the Problems panel; double-click to reset"
      onDoubleClick={resetRatio}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={cancelPointerResize}
      onPointerCancel={cancelPointerResize}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}
