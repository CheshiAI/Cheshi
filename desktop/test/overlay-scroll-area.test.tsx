import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';

test('overlay scrollbar follows content scrolling, drives scrolling, and remeasures list changes', async () => {
  const window = new Window();
  const observers: TestResizeObserver[] = [];
  class TestResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>();
    disconnected = false;
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.disconnected = true; this.targets.clear(); }
    resize() { this.callback([], this); }
  }
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Node: window.Node,
    ResizeObserver: TestResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { OverlayScrollArea } = await import('../frontend/src/shared/ui/OverlayScrollArea');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let unmounted = false;
  try {
    await act(async () => { root.render(<OverlayScrollArea label="Conversations"><button>First chat</button></OverlayScrollArea>); });
    const viewport = container.querySelector<HTMLDivElement>('[role="region"]')!;
    const scrollbar = container.querySelector<HTMLDivElement>('[aria-hidden="true"]')!;
    const extent = scrollbar.firstElementChild as HTMLElement;
    const observer = observers[0]!;
    let contentHeight = 900;
    Object.defineProperties(viewport, {
      clientHeight: { get: () => 300 },
      scrollHeight: { get: () => contentHeight },
    });
    observer.resize();
    expect(observer.targets.has(viewport)).toBe(true);
    expect(observer.targets.has(viewport.firstElementChild!)).toBe(true);
    expect(scrollbar.hidden).toBe(false);
    expect(extent.style.height).toBe('900px');

    viewport.scrollTop = 140;
    viewport.dispatchEvent(new window.Event('scroll') as unknown as Event);
    expect(scrollbar.scrollTop).toBe(140);
    expect(viewport.getAttribute('data-scrollbar-active')).toBe('true');
    scrollbar.scrollTop = 275;
    scrollbar.dispatchEvent(new window.Event('scroll') as unknown as Event);
    expect(viewport.scrollTop).toBe(275);
    expect(scrollbar.getAttribute('data-scrollbar-active')).toBe('true');

    contentHeight = 1200;
    observer.resize();
    expect(extent.style.height).toBe('1200px');
    expect(scrollbar.scrollTop).toBe(275);
    contentHeight = 200;
    viewport.scrollTop = 0;
    observer.resize();
    expect(scrollbar.hidden).toBe(true);
    expect(scrollbar.scrollTop).toBe(0);

    await act(async () => { root.unmount(); });
    unmounted = true;
    expect(observer.disconnected).toBe(true);
    viewport.scrollTop = 50;
    viewport.dispatchEvent(new window.Event('scroll') as unknown as Event);
    expect(scrollbar.scrollTop).toBe(0);
  } finally {
    if (!unmounted) await act(async () => { root.unmount(); });
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
