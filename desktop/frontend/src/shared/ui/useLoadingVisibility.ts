import { useCallback, useState } from 'react';
import { animateLoadingElement } from './loadingAnimationClock';

/** Animation and display timers run only while their loading indicator is on screen. */
export function useLoadingVisibility() {
  const [visible, setVisible] = useState(false);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const document = element.ownerDocument;
    const window = document.defaultView;
    if (!window) return;
    let intersecting = false;
    let connected = true;
    let stopAnimation: (() => void) | undefined;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      if (!connected) return;
      const active = intersecting && !document.hidden;
      setVisible(active);
      if (active && !reducedMotion.matches) stopAnimation ??= animateLoadingElement(element);
      else { stopAnimation?.(); stopAnimation = undefined; }
    };
    const observer = new window.IntersectionObserver(entries => {
      const entry = entries.find(item => item.target === element);
      if (!entry) return;
      intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    reducedMotion.addEventListener('change', update);
    return () => {
      connected = false;
      observer.disconnect();
      stopAnimation?.();
      document.removeEventListener('visibilitychange', update);
      reducedMotion.removeEventListener('change', update);
    };
  }, []);
  return { ref, visible };
}
