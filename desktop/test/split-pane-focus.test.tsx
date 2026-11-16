import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ComponentProps } from 'react';

mock.module('../frontend/src/shared/ui/SplitPaneLayout.module.css', () => ({
  default: { split: 'split', region: 'region', separator: 'separator' },
}));
const { SplitPaneLayout } = await import('../frontend/src/shared/ui/SplitPaneLayout');

type CollapsedPane = ComponentProps<typeof SplitPaneLayout>['collapsedPane'];

async function withSplit(run: (h: {
  first: HTMLElement;
  second: HTMLElement;
  outside: HTMLButtonElement;
  separator: HTMLElement;
  resizeCalls: number[];
  window: Window;
  render(collapsedPane: CollapsedPane): Promise<void>;
}) => Promise<void>, axis: 'columns' | 'rows' = 'columns') {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  const outside = document.createElement('button');
  document.body.append(outside, container);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  const resizeCalls: number[] = [];
  const render = async (collapsedPane: CollapsedPane) => {
    await act(async () => root.render(<SplitPaneLayout
      layout={{ type: 'split', id: 'workspace', axis, ratio: 0.7,
        first: { type: 'pane', paneId: 'editor' }, second: { type: 'pane', paneId: 'chat' } }}
      collapsedPane={collapsedPane}
      resizeLabel="Resize workspace panes"
      renderPane={id => <div data-pane={id}><button>Close {id}</button><input aria-label={`${id} draft`} /></div>}
      onResizeSplit={(_id, ratio) => resizeCalls.push(ratio)}
    />));
  };
  try {
    await render(null);
    const first = container.querySelector<HTMLElement>('[data-pane="editor"]')!.parentElement!;
    const second = container.querySelector<HTMLElement>('[data-pane="chat"]')!.parentElement!;
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
    await run({ first, second, outside, separator, resizeCalls, window, render });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test.each(['columns', 'rows'] as const)('%s separator retains pointer, keyboard and reset controls with the shared tooltip', async axis => {
  await withSplit(async ({ first, separator, resizeCalls, window }) => {
    const split = separator.parentElement!;
    expect(first.parentElement).toBe(split);
    expect(split.children).toHaveLength(3);
    expect(separator.hasAttribute('title')).toBe(false);
    expect(separator.hasAttribute('data-tooltip-trigger')).toBe(true);
    expect(separator.getAttribute('aria-description')).toBe('Resize workspace panes; double-click to reset');
    expect(separator.getAttribute('aria-orientation')).toBe(axis === 'columns' ? 'vertical' : 'horizontal');
    Object.defineProperty(split, 'getBoundingClientRect', {
      value: () => new window.DOMRect(0, 0, 1001, 1001),
    });
    const captured = new Set<number>();
    separator.setPointerCapture = id => { captured.add(id); };
    separator.hasPointerCapture = id => captured.has(id);
    separator.releasePointerCapture = id => { captured.delete(id); };
    const pointer = (type: string, offset: number) => separator.dispatchEvent(new window.PointerEvent(type, {
      bubbles: true, button: 0, pointerId: 7,
      clientX: axis === 'columns' ? offset : 100,
      clientY: axis === 'rows' ? offset : 100,
    }) as unknown as Event);
    await act(async () => { pointer('pointerdown', 500.5); });
    expect(captured.has(7)).toBe(true);
    expect(split.dataset.dragging).toBe('true');
    await act(async () => { pointer('pointermove', 600.5); });
    expect(resizeCalls).toHaveLength(0);
    await act(async () => { pointer('pointerup', 600.5); });
    expect(resizeCalls.at(-1)).toBeCloseTo(0.6);
    expect(captured.size).toBe(0);
    expect(split.hasAttribute('data-dragging')).toBe(false);
    await act(async () => {
      separator.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: axis === 'columns' ? 'ArrowRight' : 'ArrowDown', bubbles: true,
      }) as unknown as Event);
    });
    expect(resizeCalls.at(-1)).toBeCloseTo(0.65);
    await act(async () => {
      separator.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }) as unknown as Event);
    });
    expect(resizeCalls.at(-1)).toBe(0.5);
    await act(async () => { pointer('pointerdown', 400.5); pointer('pointercancel', 400.5); });
    expect(split.hasAttribute('data-dragging')).toBe(false);
    expect(resizeCalls).toHaveLength(3);
  }, axis);
});

test.each(['first', 'second'] as const)('collapsing %s moves focus before inert and preserves content on reopening', async side => {
  await withSplit(async ({ first, second, render }) => {
    const closing = side === 'first' ? first : second;
    const visible = side === 'first' ? second : first;
    const button = closing.querySelector('button')!;
    const draft = closing.querySelector('input')!;
    draft.value = 'unsaved draft';
    button.focus();
    expect(document.activeElement).toBe(button);
    let inertWhenFocusMoved: boolean | undefined;
    visible.addEventListener('focus', () => { inertWhenFocusMoved = closing.hasAttribute('inert'); }, { once: true });

    await render(side);
    expect(document.activeElement).toBe(visible);
    expect(inertWhenFocusMoved).toBe(false);
    expect(closing.hasAttribute('inert')).toBe(true);
    expect(visible.hasAttribute('inert')).toBe(false);
    expect(first.hasAttribute('aria-hidden')).toBe(false);
    expect(second.hasAttribute('aria-hidden')).toBe(false);
    expect(visible.tabIndex).toBe(-1);

    await render(null);
    expect(document.activeElement).toBe(visible);
    expect(closing.hasAttribute('inert')).toBe(false);
    expect(closing.querySelector('input')).toBe(draft);
    expect(draft.value).toBe('unsaved draft');
    button.focus();
    expect(document.activeElement).toBe(button);
  });
});

test('collapsing a pane preserves focus in the visible pane or outside the split', async () => {
  await withSplit(async ({ first, second, outside, render }) => {
    const button = first.querySelector('button')!;
    button.focus();
    await render('second');
    expect(document.activeElement).toBe(button);
    expect(second.hasAttribute('inert')).toBe(true);
    await render(null);
    outside.focus();
    await render('first');
    expect(document.activeElement).toBe(outside);
    expect(first.hasAttribute('inert')).toBe(true);
  });
});

test('switching collapsed sides enables the destination before moving focus', async () => {
  await withSplit(async ({ first, second, render }) => {
    await render('first');
    second.querySelector('button')!.focus();
    let destinationWasInert: boolean | undefined;
    first.addEventListener('focus', () => { destinationWasInert = first.hasAttribute('inert'); }, { once: true });
    await render('second');
    expect(destinationWasInert).toBe(false);
    expect(document.activeElement).toBe(first);
    expect(first.hasAttribute('inert')).toBe(false);
    expect(second.hasAttribute('inert')).toBe(true);
  });
});
