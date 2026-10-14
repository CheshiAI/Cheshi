import { useCallback, type CSSProperties } from 'react';
import { createSteppedEaseInOut } from './steppedEaseInOut';
import styles from './SessionActivityBackground.module.css';

// Timing applies to each half of the 6s / 8s round trip: 3s × 20 and 4s × 20.
const timing = {
  '--session-dye-flow-easing': createSteppedEaseInOut(60),
  '--session-dye-counterflow-easing': createSteppedEaseInOut(80),
} as CSSProperties;

/** Keep the layer mounted for the completion fade; idle rows need no observers. */
export function SessionActivityBackground({ active }: { active: boolean }) {
  const ref = useCallback((element: HTMLSpanElement | null) => {
    if (!element || !active) return;
    const document = element.ownerDocument;
    const window = document.defaultView;
    if (!window) return;
    let intersecting = false;
    let connected = true;
    const update = () => {
      if (!connected) return;
      const hiddenPanel = element.parentElement?.closest('[inert], [hidden], [aria-hidden="true"]');
      element.toggleAttribute('data-animating', intersecting && !document.hidden && !hiddenPanel);
    };
    const intersection = new window.IntersectionObserver(entries => {
      const entry = entries.find(item => item.target === element);
      if (!entry) return;
      intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
      update();
    });
    intersection.observe(element);
    // A mounted, inert tab can still intersect during its slide transition.
    const visibility = new window.MutationObserver(update);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      visibility.observe(parent, { attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden'] });
    }
    document.addEventListener('visibilitychange', update);
    return () => {
      connected = false;
      intersection.disconnect();
      visibility.disconnect();
      document.removeEventListener('visibilitychange', update);
      element.removeAttribute('data-animating');
    };
  }, [active]);
  return <span ref={ref} className={styles.sessionActivity} aria-hidden="true"
    data-active={active ? 'true' : undefined} style={timing} />;
}
