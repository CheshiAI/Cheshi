import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

interface HorizontalOverflowResult<T extends HTMLElement> {
  overflow: number;
  ref: RefObject<T | null>;
}

export function useHorizontalOverflow<T extends HTMLElement>(contentKey: string): HorizontalOverflowResult<T> {
  const ref = useRef<T>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const updateOverflow = (): void => {
      const nextOverflow = Math.max(0, element.scrollWidth - element.clientWidth);
      setOverflow((currentOverflow) => currentOverflow === nextOverflow ? currentOverflow : nextOverflow);
    };

    updateOverflow();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateOverflow);
      return () => window.removeEventListener('resize', updateOverflow);
    }

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [contentKey]);

  return { overflow, ref };
}
