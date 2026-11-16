interface LoadingClockWindow {
  performance: Pick<Performance, 'now'>;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
}

const FRAME_INTERVAL = 1000 / 20;
type Subscriber = (time: number) => void;
interface Clock { subscribers: Set<Subscriber>; stop(): void }
const clocks = new WeakMap<LoadingClockWindow, Clock>();

/** Batch all loader paints, including elapsed labels, instead of repainting at display refresh rate. */
export function subscribeLoadingFrame(window: LoadingClockWindow, subscriber: Subscriber) {
  let clock = clocks.get(window);
  if (!clock) {
    const subscribers = new Set<Subscriber>();
    let timer: number | undefined, frame: number | undefined;
    let lastFrame = window.performance.now();
    const schedule = () => {
      timer = window.setTimeout(() => {
        timer = undefined;
        frame = window.requestAnimationFrame(() => {
          frame = undefined;
          // Use the same monotonic clock for deadlines and elapsed time. The
          // document animation timeline can have a different origin after suspension.
          const time = window.performance.now();
          lastFrame = time;
          try {
            for (const callback of [...subscribers]) if (subscribers.has(callback)) callback(time);
          } finally {
            if (subscribers.size) schedule();
          }
        });
      }, Math.max(0, FRAME_INTERVAL - (window.performance.now() - lastFrame)));
    };
    clock = { subscribers, stop: () => {
      if (timer !== undefined) window.clearTimeout(timer);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    } };
    clocks.set(window, clock);
    schedule();
  }
  clock.subscribers.add(subscriber);
  const current = clock;
  return () => {
    current.subscribers.delete(subscriber);
    if (!current.subscribers.size && clocks.get(window) === current) {
      current.stop();
      clocks.delete(window);
    }
  };
}

/** Keep the existing keyframes, delays and cycle lengths; only their presentation cadence changes. */
export function animateLoadingElement(element: HTMLElement) {
  const window = element.ownerDocument.defaultView;
  if (!window || typeof element.getAnimations !== 'function') return () => {};
  const animations = element.getAnimations({ subtree: true }).filter(animation => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    // Nested indicators have their own visibility subscription and must not advance twice.
    return target?.closest('[data-loading-animation]') === element;
  });
  if (!animations.length) return () => {};
  const started = window.performance.now();
  const times = animations.map(animation => {
    const time = typeof animation.currentTime === 'number' ? animation.currentTime : 0;
    animation.pause();
    animation.currentTime = time;
    return time;
  });
  return subscribeLoadingFrame(window, time => {
    animations.forEach((animation, index) => { animation.currentTime = times[index]! + time - started; });
  });
}
