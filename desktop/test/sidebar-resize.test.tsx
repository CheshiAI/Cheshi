import { expect, test } from 'bun:test';
import { act, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { sidebarWidths, useSidebarResize } from '../frontend/src/features/shell/useSidebarResize';

test('sidebar widths reserve central space and review panes while adapting to smaller windows', () => {
  expect(sidebarWidths(1280, 320, { left: null, right: null }, true, false)).toMatchObject({ left: 320, right: 320 });
  const narrow = sidebarWidths(1000, 320, { left: 640, right: 640 }, true, false);
  expect(narrow.left + narrow.right).toBe(680);
  expect(narrow.left).toBeGreaterThanOrEqual(narrow.minimum);
  expect(narrow.right).toBeGreaterThanOrEqual(narrow.minimum);
  expect(sidebarWidths(1000, 320, { left: 640, right: 500 }, false, true).left).toBe(360);
  expect(sidebarWidths(1600, 320, { left: 640, right: 640 }, true, false)).toMatchObject({ left: 640, right: 640 });
  expect(sidebarWidths(1280, 280, { left: null, right: null }, true, false)).toMatchObject({ left: 280, right: 280, minimum: 175 });
});

function Fixture({ open = true, reviewing = false, disabled = false, base = 320, rail = 90 }: {
  open?: boolean; reviewing?: boolean; disabled?: boolean; base?: number; rail?: number;
}) {
  const resize = useSidebarResize({ rightOpen: open && !reviewing, reviewing: open && reviewing, disabled });
  return <div ref={resize.layoutRef} data-layout data-resizing={resize.resizing ?? ''}
    style={{ '--sidebar-width': `${base}px`, '--sidebar-rail-width': `${rail}px`, ...resize.style } as CSSProperties}>
    <div {...resize.separatorProps('left')} />
    {open && !reviewing && <div {...resize.separatorProps('right')} />}
  </div>;
}

async function withSidebar(run: (h: {
  render: (props?: Parameters<typeof Fixture>[0]) => Promise<void>;
  separator: (side: 'left' | 'right') => HTMLElement | null;
  width: (side: 'left' | 'right') => number;
  pointer: (side: 'left' | 'right', type: string, x: number, id?: number) => Promise<void>;
  key: (side: 'left' | 'right', key: string) => Promise<void>;
  reset: (side: 'left' | 'right') => Promise<void>;
  resizeWindow: (width: number) => Promise<void>;
  dragging: () => string | undefined;
  captures: Set<number>;
}) => Promise<void>) {
  const window = new Window();
  const observers = new Set<() => void>();
  class ResizeObserverMock {
    constructor(privateCallback: () => void) { this.callback = privateCallback; }
    readonly callback: () => void;
    observe() { observers.add(this.callback); }
    disconnect() { observers.delete(this.callback); }
  }
  const globals = { window, document: window.document, navigator: window.navigator,
    getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: ResizeObserverMock, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let available = 1690;
  const captures = new Set<number>();
  Object.assign(window.HTMLElement.prototype, {
    getBoundingClientRect: () => new window.DOMRect(0, 0, available, 900),
    setPointerCapture: (id: number) => { captures.add(id); },
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => { captures.delete(id); },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const separator = (side: 'left' | 'right') => container.querySelector<HTMLElement>(`[aria-label="Resize ${side} sidebar"]`);
  const layout = () => container.querySelector<HTMLElement>('[data-layout]')!;
  try {
    await run({
      render: async (props = {}) => { await act(async () => root.render(<Fixture {...props} />)); },
      separator,
      width: side => Number.parseFloat(layout().style.getPropertyValue(`--${side}-sidebar-width`)),
      pointer: async (side, type, x, id = 1) => {
        await act(async () => { separator(side)!.dispatchEvent(new window.PointerEvent(type,
          { bubbles: true, cancelable: true, pointerId: id, clientX: x, button: 0 }) as unknown as PointerEvent); });
      },
      key: async (side, key) => {
        await act(async () => { separator(side)!.dispatchEvent(new window.KeyboardEvent('keydown',
          { bubbles: true, cancelable: true, key }) as unknown as KeyboardEvent); });
      },
      reset: async side => {
        await act(async () => { separator(side)!.dispatchEvent(new window.MouseEvent('dblclick',
          { bubbles: true }) as unknown as MouseEvent); });
      },
      resizeWindow: async width => {
        available = width;
        await act(async () => { for (const measure of observers) measure(); });
      },
      dragging: () => layout().dataset.resizing,
      captures,
    });
  } finally {
    await act(async () => root.unmount());
    expect(captures.size).toBe(0);
    expect(observers.size).toBe(0);
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('left and right boundaries resize in opposite directions, clamp, and reset to the shared token', async () => {
  await withSidebar(async h => {
    await h.render({ base: 280 });
    expect(h.width('left')).toBe(280);
    expect(h.width('right')).toBe(280);
    await h.pointer('left', 'pointerdown', 280);
    expect(h.dragging()).toBe('left');
    await h.pointer('left', 'pointermove', 400, 2);
    expect(h.width('left')).toBe(280);
    await h.pointer('left', 'pointermove', 400);
    expect(h.width('left')).toBe(400);
    await h.pointer('left', 'pointerup', 420);
    expect(h.width('left')).toBe(420);
    expect(h.dragging()).toBe('');
    await h.pointer('right', 'pointerdown', 1320);
    await h.pointer('right', 'pointerup', 1200);
    expect(h.width('right')).toBe(400);
    await h.pointer('right', 'pointerdown', 1200);
    await h.pointer('right', 'pointerup', -1000);
    expect(h.width('right')).toBe(560);
    await h.pointer('left', 'pointerdown', 420);
    await h.pointer('left', 'pointerup', -1000);
    expect(h.width('left')).toBe(175);
    await h.reset('left');
    await h.reset('right');
    expect(h.width('left')).toBe(280);
    expect(h.width('right')).toBe(280);
  });
});

test('the fixed rail is deducted before sidebar and central workspace widths are allocated', async () => {
  await withSidebar(async h => {
    await h.render({ open: false });
    expect(h.width('left')).toBe(320);
    await h.key('left', 'End');
    expect(h.width('left')).toBe(640);
    await h.resizeWindow(1000);
    expect(h.width('left')).toBe(590);
    await h.render({ reviewing: true });
    expect(h.width('left')).toBe(270);
  });
});

test('keyboard resize preserves widths across closing and review mode, and viewport changes preserve preferences', async () => {
  await withSidebar(async h => {
    await h.render();
    await h.key('left', 'ArrowRight');
    await h.key('right', 'ArrowLeft');
    expect(h.width('left')).toBe(330);
    expect(h.width('right')).toBe(330);
    await h.key('left', 'End');
    await h.key('right', 'End');
    expect(h.width('left')).toBe(640);
    expect(h.width('right')).toBe(640);
    await h.resizeWindow(1090);
    expect(h.width('left') + h.width('right')).toBe(680);
    await h.render({ reviewing: true });
    expect(h.separator('right') === null).toBe(true);
    expect(h.width('left')).toBe(360);
    await h.render({ open: false });
    expect(h.width('left')).toBe(640);
    await h.resizeWindow(1690);
    await h.render();
    expect(h.width('left')).toBe(640);
    expect(h.width('right')).toBe(640);
    await h.key('right', 'Home');
    expect(h.width('right')).toBe(200);
    expect(h.separator('right')!.getAttribute('aria-valuenow')).toBe('200');
  });
});

test('cancelled or disabled drags restore the previous width and release pointer capture', async () => {
  await withSidebar(async h => {
    await h.render();
    for (const event of ['pointercancel', 'lostpointercapture']) {
      await h.pointer('left', 'pointerdown', 320);
      await h.pointer('left', 'pointermove', 500);
      await h.pointer('left', event, 500);
      expect(h.width('left')).toBe(320);
      expect(h.captures.size).toBe(0);
    }
    await h.pointer('right', 'pointerdown', 1280);
    await h.pointer('right', 'pointermove', 1100);
    await h.render({ open: false });
    expect(h.captures.size).toBe(0);
    await h.render();
    expect(h.width('right')).toBe(320);
    await h.pointer('left', 'pointerdown', 320);
    await h.pointer('left', 'pointermove', 500);
    await h.render({ disabled: true });
    expect(h.width('left')).toBe(320);
    expect(h.captures.size).toBe(0);
    await h.key('left', 'End');
    expect(h.width('left')).toBe(320);
    await h.render();
    await h.pointer('left', 'pointerdown', 320);
    // withSidebar unmounts during this final drag and verifies capture cleanup.
  });
});
