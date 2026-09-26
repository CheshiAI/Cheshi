import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar } from '../frontend/src/features/navigation/Sidebar';
import { normalizeSidebarPanel, readSidebarPanel, saveSidebarPanel } from '../frontend/src/features/navigation/sidebarPanel';
import { SidebarTabs } from '../frontend/src/shared/ui/SidebarTabs';
import { SidebarToggle, SidebarToggleVisibility } from '../frontend/src/shared/ui/SidebarToggle';

function Fixture() {
  const [active, setActive] = useState('files');
  return <SidebarTabs activeId={active} onSelect={setActive} tabs={[
    { id: 'chats', label: 'Sessions', content: <input aria-label="Session search" /> },
    { id: 'files', label: 'Files', content: <div data-scroll><input aria-label="File search" /></div> },
    { id: 'memos', label: 'Memos', content: null },
  ]} />;
}

async function withTabs(run: (h: {
  container: HTMLElement;
  window: Window;
  tab(label: string): HTMLButtonElement;
  panel(label: string): HTMLElement;
  viewport: HTMLElement;
  scrolls: ScrollToOptions[];
  settle(left: number, target?: Element): Promise<void>;
  resize(width: number): Promise<void>;
  reduceMotion(): void;
  observerConnected(): boolean;
  click(label: string): Promise<void>;
  key(label: string, key: string): Promise<void>;
  wheel(target: Element, options: WheelEventInit): Promise<Event>;
  clear(): Promise<void>;
}) => Promise<void>) {
  const window = new Window();
  let width = 320;
  let reduceMotion = false;
  let resize = () => {};
  let connected = false;
  const scrolls: ScrollToOptions[] = [];
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', { configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      scrolls.push(options);
      if (options.behavior === 'instant') this.scrollLeft = options.left ?? 0;
    },
  });
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: reduceMotion }) });
  Object.defineProperty(window, 'ResizeObserver', { value: class {
    constructor(callback: () => void) { resize = callback; }
    observe() { connected = true; }
    disconnect() { connected = false; }
  } });
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(button => button.textContent === label)!;
  const panel = (label: string) => document.getElementById(tab(label).getAttribute('aria-controls')!)!;
  try {
    await act(async () => root.render(<Fixture />));
    const viewport = panel('Files').parentElement!.parentElement!;
    await run({ container, window, tab, panel, viewport, scrolls,
      settle: async (left, target = viewport) => {
        await act(async () => {
          viewport.scrollLeft = left;
          target.dispatchEvent(new window.Event('scrollend', { bubbles: true }) as unknown as Event);
        });
      },
      resize: async next => { width = next; await act(async () => { resize(); }); },
      reduceMotion: () => { reduceMotion = true; },
      observerConnected: () => connected,
      clear: async () => { await act(async () => root.render(null)); },
      wheel: async (target, options) => {
        const event = new window.WheelEvent('wheel', { bubbles: true, cancelable: options.cancelable ?? true,
          deltaX: options.deltaX, deltaY: options.deltaY, deltaMode: options.deltaMode });
        // Happy DOM's WheelEvent does not implement the inherited mouse modifier fields.
        for (const key of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
          Object.defineProperty(event, key, { value: options[key] ?? false });
        }
        await act(async () => { target.dispatchEvent(event as unknown as Event); });
        return event as unknown as Event;
      },
      click: async label => { await act(async () => tab(label).click()); },
      key: async (label, key) => {
        await act(async () => {
          tab(label).dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
        });
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

test('sidebar exposes Sessions, Files and an empty Memos panel in that order', () => {
  const html = renderToStaticMarkup(<Sidebar activePanel="memos" onPanelChange={() => {}}
    chatPanel={<div>Session list</div>} selectedFilePath={null} onWorkspaceEntryMutation={() => {}}
    onOpenWorkspaceFile={() => {}} />);
  const window = new Window();
  window.document.body.innerHTML = html;
  const tabs = [...window.document.querySelectorAll('[role="tab"]')];
  expect(tabs.map(tab => tab.textContent)).toEqual(['Sessions', 'Files', 'Memos']);
  const selected = window.document.querySelector('[role="tab"][aria-selected="true"]')!;
  expect(selected.textContent).toBe('Memos');
  const panel = window.document.getElementById(selected.getAttribute('aria-controls')!)!;
  expect(panel.childNodes).toHaveLength(0);
  expect(panel.hasAttribute('inert')).toBe(false);
  expect(window.document.querySelector('[aria-roledescription="carousel"]')).toBeNull();
});

test('clicking tabs preserves mounted inputs and scroll positions while making inactive panels inert', async () => {
  await withTabs(async ({ container, tab, panel, click }) => {
    const files = panel('Files');
    const input = files.querySelector('input')!;
    input.value = 'keep this search';
    files.querySelector<HTMLElement>('[data-scroll]')!.scrollTop = 120;
    await click('Sessions');
    expect(files.getAttribute('aria-hidden')).toBe('true');
    expect(files.hasAttribute('inert')).toBe(true);
    expect(panel('Sessions').getAttribute('aria-hidden')).toBe('false');
    expect(panel('Sessions').hasAttribute('inert')).toBe(false);
    expect(panel('Sessions').getAttribute('aria-labelledby')).toBe(tab('Sessions').id);
    await click('Memos');
    expect(panel('Memos').childNodes).toHaveLength(0);
    expect(container.querySelectorAll('[role="tabpanel"][aria-hidden="false"]')).toHaveLength(1);
    await click('Files');
    expect(files.querySelector('input')).toBe(input);
    expect(input.value).toBe('keep this search');
    expect(files.querySelector<HTMLElement>('[data-scroll]')!.scrollTop).toBe(120);
  });
});

test('keyboard navigation moves selection and focus with one tab stop and wraps at both ends', async () => {
  await withTabs(async ({ container, window, tab, key }) => {
    expect(tab('Files').tabIndex).toBe(0);
    expect(tab('Sessions').tabIndex).toBe(-1);
    for (const [from, keyName, destination] of [
      ['Files', 'End', 'Memos'], ['Memos', 'ArrowRight', 'Sessions'],
      ['Sessions', 'ArrowLeft', 'Memos'], ['Memos', 'Home', 'Sessions'],
    ]) {
      await key(from!, keyName!);
      expect(window.document.activeElement?.id).toBe(tab(destination!).id);
      expect(tab(destination!).getAttribute('aria-selected')).toBe('true');
      expect(container.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    }
  });
});

test('rapid tab clicks scroll to the latest page without remounting panels', async () => {
  await withTabs(async ({ container, panel, click, viewport, scrolls, settle, tab }) => {
    const panels = ['Sessions', 'Files', 'Memos'].map(panel);
    const track = panels[0]!.parentElement!;
    expect(viewport.scrollLeft).toBe(320);
    for (const [label, offset] of [['Memos', 640], ['Sessions', 0], ['Memos', 640]] as const) {
      await click(label);
      expect(panel(label).parentElement).toBe(track);
      expect(scrolls.at(-1)).toEqual({ left: offset, behavior: 'smooth' });
      expect([...track.children]).toEqual(panels);
      expect(container.querySelectorAll('[role="tabpanel"][aria-hidden="false"]')).toHaveLength(1);
      expect(panel(label).hasAttribute('inert')).toBe(false);
    }
    await settle(0);
    expect(tab('Memos').getAttribute('aria-selected')).toBe('true');
    await settle(640);
    expect(tab('Memos').getAttribute('aria-selected')).toBe('true');
  });
});

test('clicking a tab moves focus out of the outgoing panel before making it inert', async () => {
  await withTabs(async ({ tab, panel, click }) => {
    const input = panel('Files').querySelector('input')!;
    input.focus();
    expect(document.activeElement).toBe(input);
    await click('Sessions');
    expect(document.activeElement).toBe(tab('Sessions'));
    expect(panel('Files').hasAttribute('inert')).toBe(true);
  });
});

test('native wheel input is never canceled or used to select a tab before scrolling settles', async () => {
  await withTabs(async ({ tab, panel, wheel }) => {
    for (const options of [{ deltaY: 100 }, { deltaX: 100, deltaY: 90 },
      { deltaX: 100 }, { deltaX: -100, cancelable: false }, { deltaX: 2, deltaMode: 1 },
      { deltaX: 100, ctrlKey: true }, { deltaX: 100, metaKey: true },
      { deltaX: 100, shiftKey: true }, { deltaX: 100, altKey: true }]) {
      expect((await wheel(panel('Files'), options)).defaultPrevented).toBe(false);
      expect(tab('Files').getAttribute('aria-selected')).toBe('true');
    }
  });
});

test('a settled native swipe updates selection and moves focus out of the outgoing panel', async () => {
  await withTabs(async ({ tab, panel, wheel, settle }) => {
    const input = panel('Files').querySelector('input')!;
    input.value = 'keep this search';
    input.focus();
    await wheel(panel('Files'), { deltaX: -8 });
    await settle(0);
    expect(tab('Sessions').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('Sessions'));
    expect(panel('Files').hasAttribute('inert')).toBe(true);
    await wheel(panel('Sessions'), { deltaX: 8, cancelable: false });
    await settle(320);
    expect(tab('Files').getAttribute('aria-selected')).toBe('true');
    expect(input.value).toBe('keep this search');
  });
});

test('consecutive swipes in the same direction work without moving the pointer or waiting', async () => {
  await withTabs(async ({ tab, panel, wheel, settle, click }) => {
    await click('Sessions');
    await settle(0);
    // The browser supplies gesture boundaries; no timer or accumulated delta decides whether to accept them.
    for (const [from, to, deltaX, left] of [
      ['Sessions', 'Files', 4, 320], ['Files', 'Memos', 4, 640],
      ['Memos', 'Files', -4, 320], ['Files', 'Sessions', -4, 0],
    ] as const) {
      await wheel(panel(from), { deltaX });
      await settle(left);
      expect(tab(to).getAttribute('aria-selected')).toBe('true');
    }
  });
});

test('vertical input does not lock out the next horizontal gesture', async () => {
  await withTabs(async ({ tab, panel, wheel, settle }) => {
    await wheel(panel('Files'), { deltaY: 100 });
    await wheel(panel('Files'), { deltaX: -4 });
    await settle(0);
    expect(tab('Sessions').getAttribute('aria-selected')).toBe('true');
  });
});

test('a user swipe can interrupt a pending smooth tab click', async () => {
  await withTabs(async ({ tab, panel, click, wheel, settle }) => {
    await click('Memos');
    await wheel(panel('Memos'), { deltaX: -4 });
    await settle(0);
    expect(tab('Sessions').getAttribute('aria-selected')).toBe('true');
  });
});

test('clicking back to the current position cancels a smooth scroll that has not moved yet', async () => {
  await withTabs(async ({ tab, click, scrolls, settle }) => {
    await click('Memos');
    await click('Files');
    expect(scrolls.at(-1)).toEqual({ left: 320, behavior: 'instant' });
    await settle(640);
    expect(tab('Files').getAttribute('aria-selected')).toBe('true');
    await settle(320);
    expect(tab('Files').getAttribute('aria-selected')).toBe('true');
  });
});

test('nested list scroll completion and partial page positions do not change tabs', async () => {
  await withTabs(async ({ tab, panel, wheel, settle }) => {
    await wheel(panel('Files'), { deltaX: -4 });
    await settle(0, panel('Files').querySelector('[data-scroll]')!);
    expect(tab('Files').getAttribute('aria-selected')).toBe('true');
    await settle(170);
    expect(tab('Files').getAttribute('aria-selected')).toBe('true');
    await settle(0);
    expect(tab('Sessions').getAttribute('aria-selected')).toBe('true');
  });
});

test('resizing or reopening the sidebar keeps the selected page aligned', async () => {
  await withTabs(async ({ tab, click, resize, viewport, scrolls }) => {
    await click('Memos');
    await resize(400);
    expect(viewport.scrollLeft).toBe(800);
    expect(scrolls.at(-1)).toEqual({ left: 800, behavior: 'instant' });
    await resize(0);
    await resize(300);
    expect(viewport.scrollLeft).toBe(600);
    expect(tab('Memos').getAttribute('aria-selected')).toBe('true');
  });
});

test('reduced motion tab clicks align immediately and unmount releases observers', async () => {
  await withTabs(async ({ reduceMotion, click, viewport, scrolls, observerConnected, clear }) => {
    reduceMotion();
    await click('Memos');
    expect(viewport.scrollLeft).toBe(640);
    expect(scrolls.at(-1)).toEqual({ left: 640, behavior: 'instant' });
    expect(observerConnected()).toBe(true);
    await clear();
    expect(observerConnected()).toBe(false);
  });
});

test('last selected tab is stored separately per workspace and invalid values fall back to Files', async () => {
  await withTabs(async ({ window }) => {
    expect(readSidebarPanel('/one')).toBe('files');
    for (const panel of ['chats', 'memos', 'files'] as const) {
      saveSidebarPanel(panel, '/one');
      expect(readSidebarPanel('/one')).toBe(panel);
    }
    saveSidebarPanel('memos', '/one');
    saveSidebarPanel('chats', '/two');
    expect(readSidebarPanel('/one')).toBe('memos');
    expect(readSidebarPanel('/two')).toBe('chats');
    const key = window.localStorage.key(0)!;
    window.localStorage.setItem(key, 'unknown');
    expect(readSidebarPanel('/one')).toBe('files');
    for (const value of [null, undefined, '', true, {}, 'unknown']) expect(normalizeSidebarPanel(value)).toBe('files');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Storage unavailable'); } });
    expect(() => saveSidebarPanel('memos', '/one')).not.toThrow();
    expect(readSidebarPanel('/one')).toBe('files');
  });
});

test('right sidebar toggles are absent until a review is available', () => {
  const markup = (visible: boolean) => renderToStaticMarkup(<SidebarToggleVisibility.Provider value={visible}>
    <SidebarToggle aria-label="Open right sidebar">Review</SidebarToggle>
  </SidebarToggleVisibility.Provider>);
  expect(markup(false)).toBe('');
  expect(markup(true)).toContain('aria-label="Open right sidebar"');
});
