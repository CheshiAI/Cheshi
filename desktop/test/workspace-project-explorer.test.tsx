import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceFileTree } from '../frontend/src/features/navigation/WorkspaceFileTree';
import type { CheshiDesktopApi, CheshiWorkspaceEntry } from '../frontend/src/cheshiDesktop';
import type { WorkspaceProject } from '../shared/workspace-projects';

test('Explorer connects sibling roots, opens identical filenames separately and removes only membership', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const primary: WorkspaceProject = { id: 'primary', rootPath: '/app', name: 'cheshi', primary: true, available: true };
  const plugin: WorkspaceProject = { id: 'plugin', rootPath: '/plugin', name: 'cheshi-flash', primary: false, available: true };
  let projects = [primary];
  const listeners = new Set<() => void>();
  const opened: string[] = [], removed: string[] = [], mutations: unknown[] = [];
  const api = {
    workspaceName: primary.name, workspaceRoot: primary.rootPath,
    workspaceProjects: {
      list: async () => [...projects],
      add: async () => { projects = [primary, plugin]; for (const listener of listeners) listener(); return projects; },
      remove: async (id: string) => { removed.push(id); projects = [primary]; for (const listener of listeners) listener(); return projects; },
      onChanged: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      invoke: async () => ({ available: false, message: '' }),
    },
    listWorkspaceDirectory: async (directory: string) => {
      const names = directory.endsWith('.config') ? ['.cache', '.nested.ts'] : ['.config', '.env', 'same.ts'];
      const entries: CheshiWorkspaceEntry[] = names.map(name => ({
        path: directory === '.' ? name : `${directory}/${name}`, name,
        kind: name === '.config' || name === '.cache' ? 'directory' : 'file',
        size: 4, modifiedAt: 1, revision: '1',
      }));
      return { path: directory, entries };
    },
    getGitSnapshot: async () => ({ available: false, message: '' }),
    onGitRepositoryChanged: () => () => {}, onWorkspaceFilesChanged: () => () => {},
  } as unknown as CheshiDesktopApi;
  const container = document.createElement('div');
  container.id = 'app';
  container.style.filter = 'brightness(0.9)';
  Object.defineProperties(container, {
    offsetWidth: { value: 1000 }, offsetHeight: { value: 800 },
    getBoundingClientRect: { value: () => new window.DOMRect(0, 0, 1000, 800) },
  });
  document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string) => {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!button) throw new Error(`Missing ${label}`);
    await act(async () => button.click());
  };
  const openProjectMenu = async (name: string) => {
    await click(`Actions for ${name}`);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    menu.style.cssText = 'display:block;visibility:visible;opacity:1;border-radius:16px';
    Object.defineProperties(menu, {
      getBoundingClientRect: { value: () => new window.DOMRect(200, 100, 280, 200) },
      getClientRects: { value: () => [new window.DOMRect(200, 100, 280, 200)] },
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.filter).toBe('');
    expect(menu.getAttribute('data-regional-blur-surface')).toBe('true');
    expect(container.style.filter).toContain('url(');
    const filter = document.getElementById(container.getAttribute('data-regional-blur-source')!)!;
    expect(filter.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')).toBe('16');
    expect(filter.querySelector('feImage')?.getAttribute('href')).toStartWith('data:image/svg+xml,');
    return filter.id;
  };
  const expectBlurRestored = (filterId: string) => {
    expect(container.style.filter).toBe('brightness(0.9)');
    expect(container.hasAttribute('data-regional-blur-source')).toBe(false);
    expect(document.getElementById(filterId)).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  };
  try {
    await act(async () => root.render(<WorkspaceFileTree api={api} selectedPath={null} onOpenFile={file => opened.push(file)}
      onEntryMutation={mutation => mutations.push(mutation)} />));
    expect(document.querySelector('[aria-label="Project cheshi-flash"]')).toBeNull();
    await click('Add project to workspace');
    expect(document.querySelectorAll('section[aria-label^="Project "]')).toHaveLength(2);
    const files = [...document.querySelectorAll<HTMLButtonElement>('button[role="treeitem"]')]
      .filter(item => item.textContent === 'same.ts');
    expect(files).toHaveLength(2);
    await act(async () => { files[0]!.click(); files[1]!.click(); });
    expect(opened).toEqual(['same.ts', '/plugin/same.ts']);
    for (const project of [primary, plugin]) {
      const section = document.querySelector(`[aria-label="Project ${project.name}"]`)!;
      const entries = () => [...section.querySelectorAll<HTMLButtonElement>('button[role="treeitem"]')];
      expect(entries().map(item => item.textContent)).toEqual(['.config', '.env', 'same.ts']);
      const directory = entries().find(item => item.textContent === '.config')!;
      await act(async () => directory.click());
      expect(entries().map(item => item.textContent)).toEqual(['.config', '.cache', '.nested.ts', '.env', 'same.ts']);
      const nestedFile = entries().find(item => item.textContent === '.nested.ts')!;
      await act(async () => nestedFile.click());
      expect(opened.at(-1)).toBe(project.primary ? '.config/.nested.ts' : '/plugin/.config/.nested.ts');
    }
    expect(document.querySelector('button[aria-label="New file"]')).toBeNull();
    const pluginRoot = document.querySelector<HTMLButtonElement>('[aria-label="Project cheshi-flash"] button[aria-expanded]')!;
    await act(async () => pluginRoot.click());
    expect(document.querySelectorAll('button[role="treeitem"]')).toHaveLength(5);
    const dismissedFilter = await openProjectMenu(plugin.name);
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }) as unknown as Event));
    expectBlurRestored(dismissedFilter);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Actions for cheshi-flash');
    const actionFilter = await openProjectMenu(plugin.name);
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.getAttribute('aria-label')))
      .toEqual(['New file', 'New folder', 'Refresh files', 'Remove from workspace']);
    await click('Remove from workspace');
    expectBlurRestored(actionFilter);
    expect(removed).toEqual(['plugin']);
    expect(mutations).toEqual([]);
    expect(document.querySelectorAll('section[aria-label^="Project "]')).toHaveLength(1);
    const outsideFilter = await openProjectMenu(primary.name);
    await act(async () => container.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }) as unknown as Event));
    expectBlurRestored(outsideFilter);
    const unmountedFilter = await openProjectMenu(primary.name);
    await act(async () => root.render(null));
    expectBlurRestored(unmountedFilter);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
