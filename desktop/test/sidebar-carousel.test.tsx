import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarCarousel } from '../frontend/src/shared/ui/SidebarCarousel';
import { SidebarToggle, SidebarToggleVisibility } from '../frontend/src/shared/ui/SidebarToggle';

function Fixture({ count }: { count: number }) {
  const [active, setActive] = useState('files');
  return <SidebarCarousel activeId={active} onSelect={setActive}
    slides={['files', 'chats', 'third', 'fourth'].slice(0, count).map(id => ({
      id, label: id, content: <div data-content={id}><input aria-label={`${id} search`} defaultValue="" /></div>,
    }))} />;
}

async function withCarousel(run: (h: {
  container: HTMLElement; window: Window; render(count: number): Promise<void>;
  settle(): Promise<void>; frame(): Promise<void>;
  click(label: string): Promise<void>; key(label: string, key: string): Promise<void>;
  wheel(x: number, y: number, time: number, options?: Pick<WheelEventInit, 'deltaMode' | 'ctrlKey' | 'metaKey' | 'altKey'> & { input?: boolean; target?: 'surface' | 'viewport' | 'item' }): Promise<boolean>;
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="Show ${label}"]`)!;
  try {
    await run({ container, window,
      render: async count => {
        await act(async () => root.render(<Fixture count={count} />));
        Object.defineProperty(container.querySelector('[aria-roledescription="slide"]')!.parentElement!, 'clientWidth', { configurable: true, value: 320 });
      },
      settle: async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); }); },
      frame: async () => { await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); }); },
      click: async label => { await act(async () => button(label).click()); },
      key: async (label, key) => {
        await act(async () => { button(label).dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as unknown as KeyboardEvent); });
      },
      wheel: async (x, y, time, options = {}) => {
        const panel = container.querySelector('[aria-roledescription="slide"][aria-hidden="false"]')!;
        const surface = container.querySelector('[aria-roledescription="carousel"]')!;
        const target = options.input ? panel.querySelector('input')!
          : options.target === 'surface' ? surface
          : options.target === 'viewport' ? panel.parentElement!.parentElement!
          : options.target === 'item' ? panel.querySelector('[data-content]')! : panel;
        const event = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: x, deltaY: y, ...options });
        Object.defineProperty(event, 'timeStamp', { value: time });
        // Happy DOM's WheelEvent currently omits the inherited MouseEvent modifiers.
        for (const key of ['ctrlKey', 'metaKey', 'altKey'] as const) {
          Object.defineProperty(event, key, { value: options[key] ?? false });
        }
        await act(async () => { target.dispatchEvent(event as unknown as WheelEvent); });
        return event.defaultPrevented;
      },
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('dots switch panels while preserving mounted input and scroll state', async () => {
  await withCarousel(async ({ container, render, click }) => {
    await render(2);
    const panels = [...container.querySelectorAll<HTMLElement>('[aria-roledescription="slide"]')];
    const files = panels[0]!, chats = panels[1]!;
    const input = files.querySelector('input')!;
    input.value = 'keep this search';
    files.querySelector<HTMLElement>('[data-content]')!.scrollTop = 120;
    expect(files.hasAttribute('inert')).toBe(false);
    expect(chats.hasAttribute('inert')).toBe(true);
    await click('chats');
    expect(files.getAttribute('aria-hidden')).toBe('true');
    expect(files.hasAttribute('inert')).toBe(true);
    expect(chats.getAttribute('aria-hidden')).toBe('false');
    expect(chats.hasAttribute('inert')).toBe(false);
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.querySelector('button[aria-pressed="true"]')?.getAttribute('aria-controls')).toBe(chats.id);
    await click('files');
    expect(files.querySelector('input')).toBe(input);
    expect(input.value).toBe('keep this search');
    expect(files.querySelector<HTMLElement>('[data-content]')!.scrollTop).toBe(120);
  });
});

test('supports four panels and keyboard navigation with focus following the selected dot', async () => {
  await withCarousel(async ({ container, window, render, click, key }) => {
    await render(4);
    expect(container.querySelectorAll('button')).toHaveLength(4);
    await key('files', 'End');
    expect(window.document.activeElement?.getAttribute('aria-label')).toBe('Show fourth');
    expect(container.querySelector('button[aria-pressed="true"]')?.getAttribute('aria-label')).toBe('Show fourth');
    await key('fourth', 'ArrowRight');
    expect(window.document.activeElement?.getAttribute('aria-label')).toBe('Show files');
    await click('third');
    expect(container.querySelector('[aria-roledescription="slide"][aria-hidden="false"]')?.getAttribute('aria-label')).toBe('third (3 of 4)');
    await render(2);
    expect(container.querySelector('button[aria-pressed="true"]')?.getAttribute('aria-label')).toBe('Show files');
    expect(container.querySelectorAll('[aria-roledescription="slide"][aria-hidden="false"]')).toHaveLength(1);
  });
});

test('right sidebar toggles are absent until a review is available', () => {
  const markup = (visible: boolean) => renderToStaticMarkup(<SidebarToggleVisibility.Provider value={visible}>
    <SidebarToggle aria-label="Open right sidebar">Review</SidebarToggle>
  </SidebarToggleVisibility.Provider>);
  expect(markup(false)).toBe('');
  expect(markup(true)).toContain('aria-label="Open right sidebar"');
});

function selectedPanel(container: HTMLElement) {
  return container.querySelector('button[aria-pressed="true"]')?.getAttribute('aria-label');
}

function highlightedPanel(container: HTMLElement) {
  return container.querySelector('button[data-highlighted="true"]')?.getAttribute('aria-label');
}

function swipeOffset(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[aria-roledescription="slide"]')!.parentElement!.style.getPropertyValue('--sidebar-swipe-offset');
}

test('follows horizontal input, reverses immediately and restores a short swipe', async () => {
  await withCarousel(async ({ container, render, wheel, frame, settle }) => {
    await render(2);
    expect(await wheel(40, 2, 0)).toBe(true);
    await frame();
    expect(swipeOffset(container)).toBe('-40px');
    expect(selectedPanel(container)).toBe('Show files');
    await wheel(-25, 0, 20);
    await frame();
    expect(swipeOffset(container)).toBe('-15px');
    await settle();
    expect(swipeOffset(container)).toBe('');
    expect(container.querySelector('[data-swiping]')).toBeNull();
    expect(selectedPanel(container)).toBe('Show files');
  });
});

test('settles to a neighbor only once after the whole momentum sequence', async () => {
  await withCarousel(async ({ container, render, wheel, frame, settle }) => {
    await render(4);
    for (let time = 0; time <= 1000; time += 40) await wheel(60, 0, time);
    await frame();
    expect(swipeOffset(container)).toBe('-320px');
    expect(selectedPanel(container)).toBe('Show files');
    await settle();
    expect(selectedPanel(container)).toBe('Show chats');
    await wheel(4, 0, 1180);
    await settle();
    expect(selectedPanel(container)).toBe('Show chats');
    // A deliberate reverse is accepted even before the same-direction momentum guard expires.
    await wheel(-180, 0, 1200);
    await settle();
    expect(selectedPanel(container)).toBe('Show files');
    await wheel(200, 0, 1600);
    await settle();
    expect(selectedPanel(container)).toBe('Show chats');
  });
});

test('accepts blank surface, viewport and item input while preserving dot navigation', async () => {
  await withCarousel(async ({ container, render, wheel, frame, settle, click }) => {
    await render(4);
    await wheel(200, 0, 0, { target: 'surface' });
    await frame();
    expect(swipeOffset(container)).toBe('-200px');
    await settle();
    expect(selectedPanel(container)).toBe('Show chats');
    await wheel(200, 0, 400, { target: 'viewport' });
    await settle();
    expect(selectedPanel(container)).toBe('Show third');
    await wheel(200, 0, 800, { target: 'item' });
    await settle();
    expect(selectedPanel(container)).toBe('Show fourth');
    await wheel(-80, 0, 1200);
    await frame();
    await click('files');
    await settle();
    expect(selectedPanel(container)).toBe('Show files');
    expect(swipeOffset(container)).toBe('');
  });
});

test('vertical scrolling, diagonal drift, zoom and input editing do not switch panels', async () => {
  await withCarousel(async ({ container, render, wheel, settle }) => {
    await render(2);
    expect(await wheel(3, 60, 0)).toBe(false);
    expect(await wheel(90, 0, 20)).toBe(false);
    expect(await wheel(50, 45, 300)).toBe(false);
    expect(await wheel(60, 0, 600, { ctrlKey: true })).toBe(false);
    expect(await wheel(60, 0, 900, { metaKey: true })).toBe(false);
    expect(await wheel(60, 0, 1200, { input: true })).toBe(false);
    await settle();
    expect(selectedPanel(container)).toBe('Show files');
    expect(swipeOffset(container)).toBe('');
  });
});

test('edge resistance stays bounded and line/page wheel units are normalized', async () => {
  await withCarousel(async ({ container, render, wheel, frame, settle, click }) => {
    await render(4);
    await wheel(-300, 0, 0);
    await frame();
    expect(swipeOffset(container)).toBe('24px');
    await settle();
    expect(selectedPanel(container)).toBe('Show files');
    await wheel(12, 0, 300, { deltaMode: 1 });
    await settle();
    expect(selectedPanel(container)).toBe('Show chats');
    await wheel(1, 0, 600, { deltaMode: 2 });
    await settle();
    expect(selectedPanel(container)).toBe('Show third');
    await click('fourth');
    await wheel(300, 0, 900);
    await frame();
    expect(swipeOffset(container)).toBe('-24px');
    await settle();
    expect(selectedPanel(container)).toBe('Show fourth');
    await render(1);
    expect(await wheel(60, 0, 1200)).toBe(false);
    expect(container.querySelectorAll('[aria-roledescription="slide"]')).toHaveLength(1);
  });
});

test('changing the panel list cancels an in-flight gesture and its pending settlement', async () => {
  await withCarousel(async ({ container, render, wheel, frame, settle }) => {
    await render(4);
    await wheel(200, 0, 0);
    await frame();
    await render(1);
    await settle();
    expect(swipeOffset(container)).toBe('');
    expect(container.querySelector('[data-swiping]')).toBeNull();
    expect(container.querySelector('[aria-hidden="false"]')?.getAttribute('aria-label')).toBe('files (1 of 1)');
  });
});

test('a reverse gesture continues from the visible position during a settling transition', async () => {
  await withCarousel(async ({ container, window, render, wheel, frame, settle }) => {
    await render(2);
    await wheel(200, 0, 0);
    await settle();
    expect(selectedPanel(container)).toBe('Show chats');
    const getComputedStyle = window.getComputedStyle.bind(window);
    // Happy DOM does not animate transforms; supply the browser's intermediate position.
    window.getComputedStyle = element => new Proxy(getComputedStyle(element), {
      get(style, key) {
        return key === 'transform' ? 'matrix(1, 0, 0, 1, -240, 0)' : Reflect.get(style, key);
      },
    });
    try {
      await wheel(-20, 0, 180);
      await frame();
      expect(swipeOffset(container)).toBe('100px');
      await wheel(-80, 0, 200);
      await settle();
      expect(selectedPanel(container)).toBe('Show files');
    } finally {
      window.getComputedStyle = getComputedStyle;
    }
  });
});

test('dots follow midpoint crossings before settlement and reverse with the panel', async () => {
  await withCarousel(async ({ container, render, wheel, frame, settle }) => {
    await render(4);
    await wheel(159, 0, 0);
    await frame();
    expect(highlightedPanel(container)).toBe('Show files');
    await wheel(1, 0, 20);
    await frame();
    expect(highlightedPanel(container)).toBe('Show chats');
    expect(selectedPanel(container)).toBe('Show files');
    await wheel(-20, 0, 40);
    await frame();
    expect(highlightedPanel(container)).toBe('Show files');
    await settle();
    expect(highlightedPanel(container)).toBe('Show files');
    await wheel(200, 0, 400);
    await frame();
    expect(highlightedPanel(container)).toBe('Show chats');
    await settle();
    expect(highlightedPanel(container)).toBe('Show chats');
    expect(selectedPanel(container)).toBe('Show chats');
    await wheel(-160, 0, 800);
    await frame();
    expect(highlightedPanel(container)).toBe('Show files');
    expect(selectedPanel(container)).toBe('Show chats');
    await settle();
    expect(highlightedPanel(container)).toBe('Show files');
  });
});

test('dot preview respects edges and clears on explicit selection or a changed panel list', async () => {
  await withCarousel(async ({ container, render, wheel, frame, settle, click, key }) => {
    await render(4);
    await wheel(-300, 0, 0);
    await frame();
    expect(highlightedPanel(container)).toBe('Show files');
    await settle();
    await wheel(200, 0, 400);
    await frame();
    expect(highlightedPanel(container)).toBe('Show chats');
    await click('third');
    expect(highlightedPanel(container)).toBe('Show third');
    await settle();
    expect(highlightedPanel(container)).toBe('Show third');
    await wheel(200, 0, 800);
    await frame();
    expect(highlightedPanel(container)).toBe('Show fourth');
    await key('third', 'Home');
    expect(highlightedPanel(container)).toBe('Show files');
    await wheel(200, 0, 1200);
    await frame();
    await render(2);
    expect(highlightedPanel(container)).toBe('Show files');
    await settle();
    expect(highlightedPanel(container)).toBe('Show files');
  });
});
