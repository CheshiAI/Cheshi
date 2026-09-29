import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ComponentProps } from 'react';
import { ChatSessionList } from '../frontend/src/features/chat/ChatSessionList';

type Props = ComponentProps<typeof ChatSessionList>;
async function withList(run: (h: {
  render: (options?: Partial<Props>) => Promise<void>; document: Document;
  viewport: () => HTMLElement; refresh: () => HTMLButtonElement; row: () => HTMLButtonElement;
  pointer: (type: string, y: number, x?: number) => Promise<void>;
  wheel: (deltaY: number, deltaX?: number) => Promise<void>; idle: () => Promise<void>;
  opened: string[]; unmount: () => Promise<void>;
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    Element: window.Element, Node: window.Node, ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const document = window.document as unknown as Document;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); let mounted = true; const opened: string[] = [];
  const props: Props = { sessions: [{ id: 'one', title: 'Saved session', updatedAt: 1 }], loading: false,
    activeSessionId: 'one', responseThreadIds: [], newChatDisabled: false, selectionDisabled: false,
    onOpen: id => opened.push(id), onNew() {}, onDelete() {}, deleteReason: () => null, onRefresh: async () => {} };
  const viewport = () => document.querySelector<HTMLElement>('[aria-label="Conversation list"]')!;
  const row = () => document.querySelector<HTMLButtonElement>('button[aria-label="Saved session"]')!;
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  try {
    await run({ document, viewport, row, opened, unmount,
      render: async options => { await act(async () => root.render(<ChatSessionList {...props} {...options} />)); },
      refresh: () => document.querySelector<HTMLButtonElement>('button[aria-label="Refresh sessions"]')!,
      pointer: async (type, y, x = 10) => { await act(async () => {
        const event = new window.PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true,
          clientY: y, clientX: x, button: 0, bubbles: true, cancelable: true });
        if (type === 'pointerdown') row().dispatchEvent(event as unknown as Event);
        else window.dispatchEvent(event);
      }); },
      wheel: async (deltaY, deltaX = 0) => { await act(async () => {
        viewport().dispatchEvent(new window.WheelEvent('wheel', { deltaY, deltaX, bubbles: true, cancelable: true }) as unknown as Event);
      }); },
      idle: async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); }); },
    });
  } finally {
    await unmount(); await window.happyDOM.abort();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

test('refresh button keeps sessions and selection, blocks duplicate requests, and permits retry after failure', async () => {
  await withList(async h => {
    const gate = deferred(); let calls = 0;
    await h.render({ onRefresh: async () => { calls++; await gate.promise; throw new Error('Refresh failed'); } });
    await act(async () => h.refresh().click());
    expect(h.refresh().disabled).toBe(true); expect(h.row().getAttribute('aria-current')).toBe('page');
    expect(h.document.querySelector('[role="status"]')?.textContent).toBe('Release to refresh');
    await act(async () => h.refresh().click());
    await h.pointer('pointerdown', 10); await h.pointer('pointermove', 110); await h.pointer('pointerup', 110);
    expect(calls).toBe(1); expect(h.opened).toEqual([]);
    await act(async () => gate.resolve());
    expect(h.refresh().disabled).toBe(false); expect(h.document.querySelector('[role="alert"]')?.textContent).toBe('Refresh failed');
    await h.render({ onRefresh: async () => { calls++; } });
    await act(async () => h.refresh().click());
    expect(calls).toBe(2); expect(h.document.querySelector('[role="alert"]')).toBeNull();
  });
});

test('dragging at the top refreshes only on release and suppresses the resulting session click', async () => {
  await withList(async h => {
    const gate = deferred();
    let calls = 0; await h.render({ onRefresh: async () => { calls++; await gate.promise; } });
    await h.pointer('pointerdown', 10); await h.pointer('pointermove', 100);
    expect(calls).toBe(0); expect(h.document.querySelector('[role="status"]')?.textContent).toBe('Release to refresh');
    const status = h.document.querySelector<HTMLElement>('[role="status"]')!;
    const indicator = status.firstElementChild;
    expect(indicator?.children.length).toBe(9);
    const readyHeight = status.style.height;
    expect(Number.parseFloat(readyHeight)).toBeGreaterThan(0);
    await h.pointer('pointermove', 220);
    expect(status.style.height).toBe(readyHeight);
    await h.pointer('pointerup', 100); expect(calls).toBe(1);
    expect(h.document.querySelectorAll('[role="status"]').length).toBe(1);
    expect(h.document.querySelector('[role="status"]')).toBe(status);
    expect(status.firstElementChild).toBe(indicator);
    expect(status.style.height).toBe(readyHeight);
    expect(status.textContent).toBe('Release to refresh');
    await act(async () => h.row().dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
    expect(h.opened).toEqual([]);
    await act(async () => h.row().click()); expect(h.opened).toEqual(['one']);
    await act(async () => gate.resolve());
    expect(h.document.querySelector('[role="status"]')).toBeNull();
  });
});

test('short, horizontal, cancelled and scrolled-list drags do not refresh', async () => {
  await withList(async h => {
    let calls = 0; await h.render({ onRefresh: async () => { calls++; } });
    await h.pointer('pointerdown', 10); await h.pointer('pointermove', 30); await h.pointer('pointerup', 30);
    await h.pointer('pointerdown', 10); await h.pointer('pointermove', 20, 100); await h.pointer('pointerup', 100, 100);
    await h.pointer('pointerdown', 10); await h.pointer('pointermove', 100); await h.pointer('pointercancel', 100);
    h.viewport().scrollTop = 90;
    await h.pointer('pointerdown', 10); await h.pointer('pointermove', 110); await h.pointer('pointerup', 110);
    expect(calls).toBe(0); expect(h.document.querySelector('[role="status"]')).toBeNull();
  });
});

test('trackpad overscroll coalesces a gesture and does not refresh when ordinary scrolling reaches the top', async () => {
  await withList(async h => {
    let calls = 0; const gate = deferred(); await h.render({ onRefresh: async () => { calls++; await gate.promise; } });
    h.viewport().scrollTop = 30; await h.wheel(-60);
    h.viewport().scrollTop = 0; await h.wheel(-100); await h.idle(); expect(calls).toBe(0);
    await h.wheel(-30); await h.wheel(-50); expect(calls).toBe(0);
    const status = h.document.querySelector<HTMLElement>('[role="status"]')!;
    const readyHeight = status.style.height;
    await h.idle(); expect(calls).toBe(1);
    expect(h.document.querySelector('[role="status"]')).toBe(status);
    expect(status.style.height).toBe(readyHeight);
    await h.wheel(-100); await h.idle(); expect(calls).toBe(1);
    await act(async () => gate.resolve());
    await h.wheel(-10); await h.idle(); expect(calls).toBe(1);
    await h.wheel(-100, 200); await h.idle(); expect(calls).toBe(1);
    await h.wheel(-80); await h.idle(); expect(calls).toBe(2);
  });
});

test('disabled refresh and unmount cancel pending gestures', async () => {
  await withList(async h => {
    let calls = 0; const onRefresh = async () => { calls++; };
    await h.render({ onRefresh, refreshDisabled: true }); expect(h.refresh().disabled).toBe(true);
    await h.pointer('pointerdown', 10); await h.pointer('pointermove', 100); await h.pointer('pointerup', 100);
    await h.wheel(-100); await h.idle(); expect(calls).toBe(0);
    await h.render({ onRefresh }); await h.wheel(-100); await h.unmount(); await h.idle();
    expect(calls).toBe(0);
  });
});
