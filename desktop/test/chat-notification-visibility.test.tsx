import { expect, mock, test } from 'bun:test';
import { act, useRef } from 'react';
import { Window } from 'happy-dom';

const reports: Array<{ context: string; thread: string | null }> = [];
mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: {
  notificationEvents: { reportView: async (context: string, thread: string | null) => { reports.push({ context, thread }); } },
} }));
const { useChatNotificationVisibility } = await import('../frontend/src/features/chat/useChatNotificationVisibility');

test('view reporting follows session selection, clipped panes, hidden pages and unmounting', async () => {
  const window = new Window();
  let visibility = 'visible';
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => visibility });
  const observers = new Set<FakeObserver>();
  class FakeObserver {
    readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
    intersect(width: number) {
      this.callback([{ isIntersecting: width > 0, intersectionRect: { width, height: 100 } } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver);
    }
  }
  const globals = { window, document: window.document, navigator: window.navigator,
    IntersectionObserver: FakeObserver, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  function Chat({ thread, shown }: { thread: string | null; shown: boolean }) {
    const ref = useRef<HTMLElement>(null);
    useChatNotificationVisibility(ref, 'split', thread, shown);
    return <section ref={ref} />;
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const intersect = (width: number) => { for (const observer of observers) observer.intersect(width); };
  const render = async (thread: string | null, shown = true) => { await act(async () => root.render(<Chat thread={thread} shown={shown} />)); };
  try {
    await render('one'); intersect(300);
    expect(reports.at(-1)).toEqual({ context: 'split', thread: 'one' });
    intersect(0); expect(reports.at(-1)?.thread).toBeNull();
    intersect(300); await render('two'); intersect(300);
    expect(reports.at(-1)?.thread).toBe('two');
    visibility = 'hidden'; window.document.dispatchEvent(new window.Event('visibilitychange'));
    expect(reports.at(-1)?.thread).toBeNull();
    visibility = 'visible'; window.document.dispatchEvent(new window.Event('visibilitychange'));
    expect(reports.at(-1)?.thread).toBe('two');
    await render('two', false); intersect(300); expect(reports.at(-1)?.thread).toBeNull();
    await render('two'); intersect(300); expect(reports.at(-1)?.thread).toBe('two');
    container.hidden = true; intersect(300); expect(reports.at(-1)?.thread).toBeNull();
    container.hidden = false; await render(null); intersect(300); expect(reports.at(-1)?.thread).toBeNull();
  } finally {
    await act(async () => root.unmount());
    expect(reports.at(-1)?.thread).toBeNull(); expect(observers.size).toBe(0);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    window.happyDOM.abort();
  }
});
