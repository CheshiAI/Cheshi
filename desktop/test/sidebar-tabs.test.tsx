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
  click(label: string): Promise<void>;
  key(label: string, key: string): Promise<void>;
}) => Promise<void>) {
  const window = new Window();
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
    await run({ container, window, tab, panel,
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

test('horizontal and vertical wheel input remains available to content without changing tabs', async () => {
  await withTabs(async ({ window, tab, panel }) => {
    for (const [deltaX, deltaY] of [[250, 0], [-250, 0], [0, 100]]) {
      const event = new window.WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true });
      await act(async () => { panel('Files').dispatchEvent(event as unknown as WheelEvent); });
      expect(event.defaultPrevented).toBe(false);
      expect(tab('Files').getAttribute('aria-selected')).toBe('true');
    }
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
