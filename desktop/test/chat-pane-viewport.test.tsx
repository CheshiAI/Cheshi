import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { insertSplitPane, type SplitLayoutNode } from '../frontend/src/shared/ui/splitPaneModel';
import { splitPaneMinimumWidth } from '../frontend/src/shared/ui/splitPaneSizing';

mock.module('../frontend/src/shared/ui/SplitPaneLayout.module.css', () => ({
  default: { split: 'split', region: 'region', separator: 'separator' },
}));
mock.module('../frontend/src/features/chat/ChatWorkspace.module.css', () => ({
  default: { split: 'chatSplit', paneViewport: 'paneViewport', paneTrack: 'paneTrack' },
}));
const { ChatPaneViewport } = await import('../frontend/src/features/chat/ChatPaneViewport');

const pair = insertSplitPane({ type: 'pane', paneId: 'first' }, 'first', 'second', 'right', 'pair');
const triple = insertSplitPane(pair, 'second', 'third', 'right', 'nested');

interface Harness {
  window: Window;
  viewport: HTMLElement;
  scrolls: ScrollToOptions[];
  selected: string[];
  render(active: string, layout?: SplitLayoutNode): Promise<void>;
  settle(left: number, nested?: boolean): Promise<void>;
  resize(width: number): Promise<void>;
  wheel(): Promise<Event>;
  reduceMotion(): void;
  clear(): Promise<void>;
  observing(): boolean;
}

async function withViewport(run: (h: Harness) => Promise<void>) {
  const window = new Window();
  let width = 700;
  let contentWidth = 1427;
  let reduceMotion = false;
  let resized = () => {};
  let observing = false;
  let viewport: HTMLElement | null = null;
  const scrolls: ScrollToOptions[] = [];
  const selected: string[] = [];
  const prototype = window.HTMLElement.prototype;
  const originalProperties = new Map(['clientWidth', 'scrollWidth', 'scrollTo', 'getBoundingClientRect']
    .map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
  Object.defineProperty(window, 'ResizeObserver', { value: class {
    constructor(callback: () => void) { resized = callback; }
    observe() { observing = true; }
    disconnect() { observing = false; }
  } });
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: reduceMotion }) });
  Object.defineProperty(prototype, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(prototype, 'scrollWidth', { configurable: true, get: () => contentWidth });
  Object.defineProperty(prototype, 'scrollTo', { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    scrolls.push(options);
    if (options.behavior === 'instant') this.scrollLeft = options.left ?? 0;
  } });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const id = this.getAttribute('data-chat-pane-mount');
    if (id) return new window.DOMRect(['first', 'second', 'third'].indexOf(id) * 476 - (viewport?.scrollLeft ?? 0), 0, 475, 600);
    return new window.DOMRect(0, 0, width, 600);
  };
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  const render = async (active: string, layout: SplitLayoutNode = triple) => {
    contentWidth = Math.max(width, splitPaneMinimumWidth(layout, 475));
    await act(async () => root.render(<ChatPaneViewport layout={layout} activePaneId={active}
      onSelectPane={id => selected.push(id)} onResizeSplit={() => {}}
      renderPane={id => <div data-chat-pane-mount={id}><input aria-label={`${id} draft`} defaultValue="unsaved" /></div>} />));
    viewport = container.querySelector<HTMLElement>('[aria-label="Chat panes"]')!;
  };
  try {
    await render('first');
    await run({ window, viewport: viewport!, scrolls, selected, render,
      settle: async (left, nested = false) => {
        await act(async () => {
          viewport!.scrollLeft = left;
          const target = nested ? viewport!.querySelector('input')! : viewport!;
          target.dispatchEvent(new window.Event('scrollend', { bubbles: true }) as unknown as Event);
        });
      },
      resize: async next => { width = next; await act(async () => resized()); },
      wheel: async () => {
        const event = new window.WheelEvent('wheel', { deltaX: 80, bubbles: true, cancelable: true });
        await act(async () => viewport!.dispatchEvent(event as unknown as Event));
        return event as unknown as Event;
      },
      reduceMotion: () => { reduceMotion = true; },
      observing: () => observing,
      clear: async () => { await act(async () => root.render(null)); },
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of originalProperties) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else Reflect.deleteProperty(prototype, key);
    }
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('nested horizontal splits reserve 475px per pane and a divider, including 32 panes', () => {
  expect(splitPaneMinimumWidth(pair, 475)).toBe(951);
  expect(splitPaneMinimumWidth(triple, 475)).toBe(1427);
  let layout: SplitLayoutNode = { type: 'pane', paneId: 'first' };
  for (let index = 1; index < 32; index++) layout = insertSplitPane(layout, 'first', `pane-${index}`, 'right', `split-${index}`);
  expect(splitPaneMinimumWidth(layout, 475)).toBe(475 * 32 + 31);
});

test('selecting an offscreen chat aligns to its snap boundary without moving the conversation or remounting drafts', async () => {
  await withViewport(async ({ viewport, scrolls, render, settle, selected }) => {
    const input = viewport.querySelector<HTMLInputElement>('input')!;
    input.value = 'draft to retain';
    await render('second');
    expect(scrolls.at(-1)).toEqual({ left: 476, behavior: 'smooth' });
    await render('third');
    expect(scrolls.at(-1)).toEqual({ left: 727, behavior: 'smooth' });
    await settle(476); // Completion of the superseded second-pane navigation.
    expect(selected).toEqual([]);
    await settle(727);
    expect(selected).toEqual([]);
    expect(viewport.querySelector('input')).toBe(input);
    expect(input.value).toBe('draft to retain');
    const calls = scrolls.length;
    await render('second'); // Both the second and third panes are partially visible; align second.
    expect(scrolls.length).toBe(calls + 1);
    expect(scrolls.at(-1)?.left).toBe(476);
  });
});

test('native swipes select the visible pane, ignore nested vertical scroll completion and preserve drafts', async () => {
  await withViewport(async ({ viewport, selected, settle, wheel, render, scrolls }) => {
    const input = viewport.querySelector<HTMLInputElement>('input')!;
    input.value = 'keep this';
    expect((await wheel()).defaultPrevented).toBe(false);
    await settle(476, true);
    expect(selected).toEqual([]);
    await settle(476);
    expect(selected).toEqual(['second']);
    await render('second');
    expect(scrolls).toEqual([]);
    expect(viewport.querySelector('input')).toBe(input);
    expect(input.value).toBe('keep this');
  });
});

test('returning to the current pane cancels an unfinished smooth move; swipes can interrupt navigation', async () => {
  await withViewport(async ({ render, scrolls, settle, selected, wheel }) => {
    await render('third');
    await render('first');
    expect(scrolls.at(-1)).toEqual({ left: 0, behavior: 'instant' });
    await settle(727);
    expect(selected).toEqual([]);
    await settle(0);
    await render('third');
    await wheel();
    await settle(476);
    expect(selected).toEqual(['second']);
  });
});

test('two fully visible panes keep their active selection and do not force horizontal scrolling', async () => {
  await withViewport(async ({ render, resize, settle, selected, scrolls }) => {
    await resize(1000);
    await render('second', pair);
    await settle(0);
    expect(selected).toEqual([]);
    expect(scrolls).toEqual([]);
  });
});

test('reduced motion, viewport resizing and observer cleanup retain the selected chat', async () => {
  await withViewport(async ({ render, resize, reduceMotion, scrolls, observing, clear }) => {
    reduceMotion();
    await render('third');
    expect(scrolls.at(-1)).toEqual({ left: 727, behavior: 'instant' });
    await resize(500);
    expect(scrolls.at(-1)).toEqual({ left: 927, behavior: 'instant' });
    expect(observing()).toBe(true);
    await clear();
    expect(observing()).toBe(false);
  });
});
