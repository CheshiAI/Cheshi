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
  render(collapsedPane: CollapsedPane): Promise<void>;
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  const outside = document.createElement('button');
  document.body.append(outside, container);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  const render = async (collapsedPane: CollapsedPane) => {
    await act(async () => root.render(<SplitPaneLayout
      layout={{ type: 'split', id: 'workspace', axis: 'columns', ratio: 0.7,
        first: { type: 'pane', paneId: 'editor' }, second: { type: 'pane', paneId: 'chat' } }}
      collapsedPane={collapsedPane}
      renderPane={id => <div data-pane={id}><button>Close {id}</button><input aria-label={`${id} draft`} /></div>}
      onResizeSplit={() => {}}
    />));
  };
  try {
    await render(null);
    const first = container.querySelector<HTMLElement>('[data-pane="editor"]')!.parentElement!;
    const second = container.querySelector<HTMLElement>('[data-pane="chat"]')!.parentElement!;
    await run({ first, second, outside, render });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

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
