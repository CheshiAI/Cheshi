import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceFileTree } from '../frontend/src/features/navigation/WorkspaceFileTree';
import type { CheshiDesktopApi, CheshiWorkspaceEntry, GitRepositorySnapshot } from '../frontend/src/cheshiDesktop';
import type { WorkspaceProject } from '../shared/workspace-projects';
import { parseStatus } from '../lib/git-parsers.mts';

// Bun does not resolve CSS module classes; provide the tooltip's style boundary.
mock.module('../frontend/src/shared/ui/Tooltip.module.css', () => ({
  default: { anchor: 'tooltip-anchor', content: 'tooltip-content' },
}));

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
  const gitListeners = new Set<() => void>();
  const reads = new Map<string, number>();
  const longBranch = 'feature/a-very-long-branch-name-that-must-not-be-truncated-in-the-tooltip';
  const snapshots: Record<string, GitRepositorySnapshot> = {
    primary: { available: true, message: '', head: longBranch, changes: parseStatus(' M same.ts\0 D gone.ts\0') },
    plugin: { available: true, message: '', head: 'feature/plugin', changes: parseStatus('?? same.ts\0') },
  };
  const readGit = async (id: string) => {
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return snapshots[id]!;
  };
  const opened: string[] = [], removed: string[] = [], mutations: unknown[] = [];
  const api = {
    workspaceName: primary.name, workspaceRoot: primary.rootPath,
    workspaceProjects: {
      list: async () => [...projects],
      add: async () => { projects = [primary, plugin]; for (const listener of listeners) listener(); return projects; },
      remove: async (id: string) => { removed.push(id); projects = [primary]; for (const listener of listeners) listener(); return projects; },
      onChanged: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      invoke: async (id: string, channel: string) => {
        expect(channel).toBe('cheshi:get-git-snapshot');
        return readGit(id);
      },
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
    getGitSnapshot: () => readGit('primary'),
    onGitRepositoryChanged: (listener: () => void) => {
      gitListeners.add(listener);
      return () => { gitListeners.delete(listener); };
    },
    onWorkspaceFilesChanged: () => () => {},
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
  const projectRoot = (project: WorkspaceProject) => document.querySelector<HTMLButtonElement>(
    `[aria-label="Project ${project.name}"] .workspace-file-tree-root`)!;
  const expectTooltip = async (anchor: HTMLElement, content: string) => {
    // Happy DOM has no layout; supply only the tooltip anchor's visibility bounds.
    Object.defineProperties(anchor, {
      getBoundingClientRect: { configurable: true, value: () => new window.DOMRect(10, 10, 100, 28) },
      getClientRects: { configurable: true, value: () => [new window.DOMRect(10, 10, 100, 28)] },
    });
    await act(async () => anchor.dispatchEvent(new window.PointerEvent('pointerover', {
      bubbles: true, pointerType: 'mouse',
    }) as unknown as Event));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1050)); });
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(content);
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }) as unknown as Event));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  };
  try {
    await act(async () => root.render(<WorkspaceFileTree api={api} selectedPath={null} onOpenFile={file => opened.push(file)}
      onEntryMutation={mutation => mutations.push(mutation)} />));
    expect(document.querySelector('[aria-label="Project cheshi-flash"]')).toBeNull();
    expect(projectRoot(primary).textContent).toContain(longBranch);
    expect(projectRoot(primary).textContent).toContain('+1−1');
    expect(reads.get('primary')).toBe(1);
    await click('Add project to workspace');
    expect(document.querySelectorAll('section[aria-label^="Project "]')).toHaveLength(2);
    expect(projectRoot(plugin).textContent).toContain('feature/plugin+1');
    expect(projectRoot(plugin).textContent).not.toContain(longBranch);
    expect(reads.get('primary')).toBe(1);
    expect(reads.get('plugin')).toBe(1);
    expect(gitListeners.size).toBe(2);
    await expectTooltip(projectRoot(primary), `${primary.name}\n${primary.rootPath}`);
    await expectTooltip(projectRoot(primary).querySelector<HTMLElement>('[aria-label^="Current Git branch:"]')!,
      `Current Git branch: ${longBranch}`);
    primary.name = 'cheshi-project-with-a-very-long-name-for-the-explorer';
    await act(async () => { for (const listener of listeners) listener(); });
    await expectTooltip(projectRoot(primary), `${primary.name}\n${primary.rootPath}`);
    expect(reads.get('primary')).toBe(1);
    primary.name = 'cheshi';
    await act(async () => { for (const listener of listeners) listener(); });
    snapshots.plugin = { available: true, message: '', head: 'main', changes: [] };
    await act(async () => { for (const listener of gitListeners) listener(); });
    expect(projectRoot(plugin).textContent).toBe('cheshi-flashmain');
    expect(projectRoot(primary).textContent).toContain(longBranch);
    snapshots.plugin = { available: false, message: 'Not a Git repository' };
    await act(async () => { for (const listener of gitListeners) listener(); });
    expect(projectRoot(plugin).textContent).toBe('cheshi-flash');
    snapshots.plugin = { available: true, message: '', head: 'abc1234', detached: true };
    await act(async () => { for (const listener of gitListeners) listener(); });
    expect(projectRoot(plugin).textContent).toContain('Detached · abc1234');
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
    await act(async () => projectRoot(primary).click());
    await act(async () => pluginRoot.click());
    await act(async () => pluginRoot.click());
    const viewport = document.querySelector<HTMLElement>('[role="region"][aria-label="Workspace projects"]')!;
    await act(async () => viewport.dispatchEvent(new window.WheelEvent('wheel', {
      deltaY: -80, bubbles: true, cancelable: true,
    }) as unknown as Event));
    const status = document.querySelector('[data-project-refresh-status] [role="status"]')!;
    expect(status.textContent).toBe('Release to refresh');
    expect(status.closest('section[aria-label^="Project "]')).toBeNull();
    expect(status.parentElement?.nextElementSibling?.getAttribute('aria-label')).toBe('Project cheshi');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    expect(status.textContent).toBe('Refreshing…');
    expect(projectRoot(primary).getAttribute('aria-expanded')).toBe('false');
    expect(pluginRoot.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
    expect(document.querySelector('[data-project-refresh-status] [role="status"]') === null).toBe(true);
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
    expect(gitListeners.size).toBe(1);
    const outsideFilter = await openProjectMenu(primary.name);
    await act(async () => container.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }) as unknown as Event));
    expectBlurRestored(outsideFilter);
    const unmountedFilter = await openProjectMenu(primary.name);
    await act(async () => root.render(null));
    expectBlurRestored(unmountedFilter);
    expect(gitListeners.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 10_000);
