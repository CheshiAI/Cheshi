import { useLayoutEffect, useRef, useState } from 'react';

export const MIN_PROBLEMS_RATIO = 0.1;
export const MAX_PROBLEMS_RATIO = 0.9;
export const PROBLEMS_RESIZER_SIZE = 1;
const MIN_EDITOR_SIZE = 120;
const MIN_PROBLEMS_SIZE = 150;

export function clampProblemsRatio(ratio: number, availableSize: number): number {
  if (availableSize <= 0) {
    return Math.min(MAX_PROBLEMS_RATIO, Math.max(MIN_PROBLEMS_RATIO, ratio));
  }

  const minimum = Math.min(
    0.5,
    Math.max(MIN_PROBLEMS_RATIO, MIN_PROBLEMS_SIZE / availableSize),
  );
  const maximum = Math.max(
    0.5,
    Math.min(MAX_PROBLEMS_RATIO, 1 - MIN_EDITOR_SIZE / availableSize),
  );
  return Math.min(maximum, Math.max(minimum, ratio));
}

export function useWorkspaceProblemsLayout(preferredRatio: number, active: boolean) {
  const stageRef = useRef<HTMLElement>(null);
  const [availableSize, setAvailableSize] = useState(0);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!active || !stage) return undefined;

    const updateSize = (): void => {
      const nextSize = Math.max(0, stage.getBoundingClientRect().height - PROBLEMS_RESIZER_SIZE);
      setAvailableSize((currentSize) => currentSize === nextSize ? currentSize : nextSize);
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    // Observe the complete stage, not its animated grid tracks.
    observer.observe(stage);
    return () => observer.disconnect();
  }, [active]);

  return {
    stageRef,
    // Window resizing changes the displayed ratio without overwriting the user's preference.
    ratio: clampProblemsRatio(preferredRatio, availableSize),
  };
}
