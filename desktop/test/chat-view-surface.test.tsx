import { expect, test } from 'bun:test';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { ChatViewSurface } from '../frontend/src/features/chat/ChatViewSurface';

function Fixture({ thread = 'one', width = 794 }: { thread?: string; width?: number }) {
  const rootRef = useRef<HTMLElement>(null);
  const timelineRef = useRef<HTMLElement>(null);
  return <ChatViewSurface rootRef={rootRef} timelineRef={timelineRef}>
    <section key={thread} ref={timelineRef} data-timeline="true" data-width={width}><p>Message</p></section>
    <footer><textarea defaultValue="Keep this draft" /></footer>
  </ChatViewSurface>;
}

async function withSurface(run: (h: {
  render: (props?: Parameters<typeof Fixture>[0]) => Promise<void>;
  root: () => HTMLElement; timeline: () => HTMLElement;
  resize: (target: Element, width: number) => void;
  observed: (target: Element) => boolean; unmount: () => Promise<void>;
}) => Promise<void>) {
  const window = new Window();
  const observers = new Set<Observer>();
  class Observer implements ResizeObserver {
    targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Node: window.Node, MutationObserver: window.MutationObserver,
    ResizeObserver: Observer, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true, get() { return Number(this.getAttribute('data-width') ?? 0); },
  });
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const reactRoot = createRoot(container as unknown as HTMLElement);
  let mounted = true;
  const unmount = async () => { if (mounted) { await act(async () => reactRoot.unmount()); mounted = false; } };
  try {
    await run({
      render: async props => { await act(async () => reactRoot.render(<Fixture {...props} />)); },
      root: () => container.firstElementChild as unknown as HTMLElement,
      timeline: () => container.querySelector('[data-timeline]') as unknown as HTMLElement,
      resize: (target, width) => {
        const contentRect = { x: 0, y: 0, width, height: 500, top: 0, right: width, bottom: 500, left: 0, toJSON() { return {}; } };
        for (const observer of observers) if (observer.targets.has(target)) observer.callback([
          { target, contentRect, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] },
        ], observer);
      },
      observed: target => [...observers].some(observer => observer.targets.has(target)),
      unmount,
    });
  } finally {
    await unmount();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('composer width follows the usable timeline width as scrollbars and pane sizes change', async () => {
  await withSurface(async h => {
    await h.render();
    const width = () => h.root().style.getPropertyValue('--chat-viewport-width');
    expect(width()).toBe('794px');
    h.resize(h.timeline(), 800);
    expect(width()).toBe('800px');
    h.resize(h.timeline(), 794);
    expect(width()).toBe('794px');
    h.resize(h.timeline(), 413.625);
    expect(width()).toBe('413.625px');
    h.resize(h.timeline(), 0);
    expect(width()).toBe('413.625px');
    h.resize(h.timeline(), 620.5);
    expect(width()).toBe('620.5px');
    expect(h.root().querySelector('textarea')?.value).toBe('Keep this draft');
  });
});

test('a replacement timeline reconnects measurement and unmount releases the observer and width', async () => {
  await withSurface(async h => {
    await h.render();
    const oldTimeline = h.timeline();
    await h.render({ thread: 'two', width: 600 });
    expect(h.timeline()).not.toBe(oldTimeline);
    expect(h.observed(oldTimeline)).toBe(false);
    expect(h.observed(h.timeline())).toBe(true);
    expect(h.root().style.getPropertyValue('--chat-viewport-width')).toBe('600px');
    h.resize(oldTimeline, 100);
    expect(h.root().style.getPropertyValue('--chat-viewport-width')).toBe('600px');
    const root = h.root(), timeline = h.timeline();
    await h.unmount();
    expect(h.observed(timeline)).toBe(false);
    expect(root.style.getPropertyValue('--chat-viewport-width')).toBe('');
  });
});
