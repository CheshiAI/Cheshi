import { expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useLoadingVisibility } from '../frontend/src/shared/ui/useLoadingVisibility';

function Fixture() {
  const { ref, visible } = useLoadingVisibility();
  return <div ref={ref} data-visible={visible} data-loading-animation="true" />;
}

test('visibility follows scrolling and hidden documents, and unmount releases observers and listeners', async () => {
  const window = new Window();
  let hidden = false;
  let reduced = false, nextTimer = 0;
  const timers = new Set<number>();
  const motionListeners = new Set<() => void>();
  const animationDescriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'getAnimations');
  Object.defineProperty(window.HTMLElement.prototype, 'getAnimations', { configurable: true, value() {
    return [{ currentTime: 0, effect: { target: this }, pause() {} }];
  } });
  Object.defineProperties(window, {
    setTimeout: { configurable: true, value: () => { const id = ++nextTimer; timers.add(id); return id; } },
    clearTimeout: { configurable: true, value: (id: number) => timers.delete(id) },
    matchMedia: { configurable: true, value: () => ({
      get matches() { return reduced; },
      addEventListener(_type: string, listener: () => void) { motionListeners.add(listener); },
      removeEventListener(_type: string, listener: () => void) { motionListeners.delete(listener); },
    }) },
  });
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  const observers: Observer[] = [];
  class Observer {
    element: Element | null = null;
    constructor(readonly callback: IntersectionObserverCallback) { observers.push(this); }
    observe(element: Element) { this.element = element; }
    disconnect() { this.element = null; }
    emit(visible: boolean, target = this.element) {
      if (!target) return;
      const rect = target.getBoundingClientRect();
      this.callback([{ target, time: 0, isIntersecting: visible, intersectionRatio: visible ? 1 : 0,
        boundingClientRect: rect, intersectionRect: rect, rootBounds: null }], this as unknown as IntersectionObserver);
    }
  }
  Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: Observer });
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  let mounted = true;
  try {
    await act(async () => root.render(<Fixture />));
    const target = container.firstElementChild!;
    const visible = () => target.getAttribute('data-visible');
    expect(visible()).toBe('false');
    const observer = observers[0]!;
    await act(async () => observer.emit(true));
    expect(visible()).toBe('true');
    expect(timers.size).toBe(1);
    await act(async () => observer.emit(false));
    expect(visible()).toBe('false');
    expect(timers.size).toBe(0);
    await act(async () => observer.emit(true));
    expect(visible()).toBe('true');
    hidden = true;
    await act(async () => window.document.dispatchEvent(new window.Event('visibilitychange')));
    expect(visible()).toBe('false');
    expect(timers.size).toBe(0);
    // An intersection notification must not resume a hidden document.
    await act(async () => observer.emit(true));
    expect(visible()).toBe('false');
    hidden = false;
    await act(async () => window.document.dispatchEvent(new window.Event('visibilitychange')));
    expect(visible()).toBe('true');
    expect(timers.size).toBe(1);
    reduced = true;
    await act(async () => motionListeners.forEach(listener => listener()));
    expect(visible()).toBe('true');
    expect(timers.size).toBe(0);
    reduced = false;
    await act(async () => motionListeners.forEach(listener => listener()));
    expect(timers.size).toBe(1);
    await act(async () => root.unmount());
    mounted = false;
    expect(observer.element).toBeNull();
    expect(timers.size).toBe(0);
    expect(motionListeners.size).toBe(0);
    // Queued notifications after disposal are ignored.
    await act(async () => observer.emit(false, target as unknown as Element));
    expect(visible()).toBe('true');
  } finally {
    if (mounted) await act(async () => root.unmount());
    if (animationDescriptor) Object.defineProperty(window.HTMLElement.prototype, 'getAnimations', animationDescriptor);
    else Reflect.deleteProperty(window.HTMLElement.prototype, 'getAnimations');
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
