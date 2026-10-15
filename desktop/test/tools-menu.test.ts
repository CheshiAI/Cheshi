import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import type { Menu, MenuItemConstructorOptions } from 'electron';
import { createToolsMenu } from '../lib/tools-menu.mts';
import { createWorkspaceManagementApi } from '../lib/workspace-management-preload.cts';
import { OPEN_HELP_CHANNEL, OPEN_RELATIONSHIP_GRAPH_CHANNEL, OPEN_VOICE_CHANNEL } from '../shared/workspace-management';
import config from '../../forge.config.mts';

const buildMenu: typeof Menu.buildFromTemplate = items => ({
  items, getMenuItemById: (id: string) => items.find(item => item.id === id),
}) as Menu;

function windowFixture() {
  const sent: string[] = [];
  const state = { destroyed: false, contentsDestroyed: false, loading: false, minimized: false, shown: 0, focused: 0, restored: 0 };
  const events = new EventEmitter();
  const contents = { isDestroyed: () => state.contentsDestroyed, isLoadingMainFrame: () => state.loading,
    on: events.on.bind(events), off: events.off.bind(events),
    send: (channel: string) => { sent.push(channel); } };
  const window = {
    isDestroyed: () => state.destroyed, isMinimized: () => state.minimized,
    restore: () => { state.restored++; state.minimized = false; },
    show: () => { state.shown++; }, focus: () => { state.focused++; },
    get webContents() {
      if (state.destroyed) throw new TypeError('Object has been destroyed');
      return contents;
    },
  };
  return { window, state, sent, events };
}

function menuFixture(commandId = 'cheshi-relationship-graph') {
  let windows: ReturnType<typeof windowFixture>['window'][] = [];
  let focused: typeof windows[number] | null = null;
  const listeners = new Set<() => void>();
  const input: MenuItemConstructorOptions[] = [{ label: 'Window' }, { role: 'help', label: 'Help' }, { label: 'Notes' }];
  const result = createToolsMenu(input, { buildMenu, focused: () => focused, windows: () => windows,
    onWindowsChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
  const submenu = result.template.find(item => item.id === 'cheshi-tools')!.submenu as Menu;
  const command = submenu.getMenuItemById(commandId)!;
  return { ...result, submenu, command, listeners,
    focus: (window: typeof focused) => { focused = window; },
    windows: (value: typeof windows) => { windows = value; for (const listener of listeners) listener(); },
    click: () => { (command.click as () => void)(); },
  };
}

test('Tools appears immediately before Help with a disabled graph command until a project is ready', () => {
  const menu = menuFixture();
  expect(menu.template.map(item => item.label)).toEqual(['Window', 'Tools', 'Help', 'Notes']);
  expect(menu.command.label).toBe('Relationship Graph');
  expect(menu.command.enabled).toBe(false);
  menu.click();
  const project = windowFixture();
  menu.windows([project.window]);
  expect(menu.command.enabled).toBe(true);
  project.state.loading = true; project.events.emit('did-start-loading');
  expect(menu.command.enabled).toBe(false);
  project.state.loading = false; project.events.emit('did-stop-loading');
  expect(menu.command.enabled).toBe(true);
  menu.windows([]);
  expect(menu.command.enabled).toBe(false);
  expect(project.events.listenerCount('did-stop-loading')).toBe(0);
  menu.dispose();
  expect(menu.listeners.size).toBe(0);
});

test('graph command targets the focused project, restores it and never sends to auxiliary windows', () => {
  const menu = menuFixture(), first = windowFixture(), second = windowFixture(), auxiliary = windowFixture();
  menu.windows([first.window, second.window]);
  menu.focus(second.window); second.state.minimized = true;
  menu.click();
  expect(second.sent).toEqual([OPEN_RELATIONSHIP_GRAPH_CHANNEL]);
  expect(second.state).toMatchObject({ shown: 1, focused: 1, restored: 1 });
  expect(first.sent).toEqual([]);
  menu.focus(auxiliary.window); menu.click();
  expect(first.sent).toEqual([OPEN_RELATIONSHIP_GRAPH_CHANNEL]);
  expect(auxiliary.sent).toEqual([]);
  first.state.destroyed = true; second.state.loading = true;
  menu.windows([first.window, second.window]);
  expect(menu.command.enabled).toBe(false);
  menu.click();
  expect(second.sent).toHaveLength(1);
  second.state.loading = false; second.state.contentsDestroyed = true;
  menu.windows([second.window]);
  expect(menu.command.enabled).toBe(false);
  menu.dispose();
});

test('a project closed after menu opening is not sent a stale graph request', () => {
  const menu = menuFixture(), project = windowFixture();
  menu.windows([project.window]);
  project.state.destroyed = true;
  menu.click();
  expect(project.sent).toEqual([]);
  menu.dispose();
});

test('closing a destroyed window removes its listeners and preserves remaining project controls', () => {
  const menu = menuFixture(), closed = windowFixture(), remaining = windowFixture();
  menu.windows([closed.window, remaining.window]);
  closed.state.destroyed = true; closed.state.contentsDestroyed = true;
  menu.windows([remaining.window]);
  expect(closed.events.listenerCount('did-start-loading')).toBe(0);
  expect(closed.events.listenerCount('did-stop-loading')).toBe(0);
  expect(menu.command.enabled).toBe(true);
  remaining.state.loading = true; remaining.events.emit('did-start-loading');
  expect(menu.command.enabled).toBe(false);
  remaining.state.destroyed = true; remaining.state.contentsDestroyed = true;
  menu.windows([]);
  expect(remaining.events.listenerCount('did-stop-loading')).toBe(0);
  expect(menu.command.enabled).toBe(false);
  menu.dispose();
});

test('app shutdown releases destroyed windows and repeated disposal is harmless', () => {
  const menu = menuFixture(), project = windowFixture();
  menu.windows([project.window]);
  project.state.destroyed = true; project.state.contentsDestroyed = true;
  menu.dispose();
  menu.dispose();
  expect(menu.listeners.size).toBe(0);
  expect(project.events.listenerCount('did-start-loading')).toBe(0);
  expect(project.events.listenerCount('did-stop-loading')).toBe(0);
});

test('a stale window list never subscribes to destroyed windows or web contents', () => {
  const menu = menuFixture(), closed = windowFixture(), destroyedContents = windowFixture();
  closed.state.destroyed = true;
  destroyedContents.state.contentsDestroyed = true;
  menu.windows([closed.window, destroyedContents.window]);
  expect(menu.command.enabled).toBe(false);
  expect(closed.events.listenerCount('did-start-loading')).toBe(0);
  expect(destroyedContents.events.listenerCount('did-start-loading')).toBe(0);
  menu.dispose();
});

test.each([
  [OPEN_RELATIONSHIP_GRAPH_CHANNEL, 'onRelationshipGraphRequested'], [OPEN_VOICE_CHANNEL, 'onVoiceRequested'],
] as const)('%s buffers requests independently from Help and releases renderer subscriptions', (channel, subscribe) => {
  const ipc = Object.assign(new EventEmitter(), { invoke: async () => null });
  const api = createWorkspaceManagementApi(ipc);
  let graph = 0, help = 0;
  ipc.emit(channel); ipc.emit(channel);
  const closeGraph = api[subscribe]!(() => { graph++; });
  const closeHelp = api.onHelpRequested!(() => { help++; });
  expect(graph).toBe(1); expect(help).toBe(0);
  ipc.emit(OPEN_HELP_CHANNEL); expect(help).toBe(1); expect(graph).toBe(1);
  ipc.emit(channel); expect(graph).toBe(2);
  closeGraph(); ipc.emit(channel); expect(graph).toBe(2);
  const remove = api[subscribe]!(() => { graph++; });
  expect(graph).toBe(3); remove(); closeHelp();
});

test('VOICE follows Relationship Graph and routes only to a ready project', () => {
  const menu = menuFixture('cheshi-voice');
  expect(menu.submenu.items.map(item => item.label)).toEqual(['Relationship Graph', 'Voice']);
  expect(menu.command.enabled).toBe(false);
  menu.click();
  const first = windowFixture(), second = windowFixture(), auxiliary = windowFixture();
  menu.windows([first.window, second.window]);
  menu.focus(second.window);
  second.state.minimized = true;
  expect(menu.command.enabled).toBe(true);
  menu.click();
  expect(second.sent).toEqual([OPEN_VOICE_CHANNEL]);
  expect(second.state).toMatchObject({ shown: 1, focused: 1, restored: 1 });
  expect(first.sent).toEqual([]);
  menu.focus(auxiliary.window); menu.click();
  expect(first.sent).toEqual([OPEN_VOICE_CHANNEL]);
  expect(auxiliary.sent).toEqual([]);
  first.state.loading = true; second.state.loading = true;
  second.events.emit('did-start-loading');
  expect(menu.command.enabled).toBe(false);
  menu.click();
  expect(second.sent).toHaveLength(1);
  second.state.loading = false;
  second.events.emit('did-stop-loading');
  expect(menu.command.enabled).toBe(true);
  second.state.destroyed = true;
  menu.click();
  expect(second.sent).toHaveLength(1);
  menu.windows([]);
  expect(menu.command.enabled).toBe(false);
  menu.dispose();
});

test('tools menu and its shared contract are packaged and load with native Node', async () => {
  const ignore = (await config()).packagerConfig!.ignore;
  if (typeof ignore !== 'function') throw new Error('Expected package filter');
  expect(ignore('/desktop/lib/tools-menu.mts')).toBe(false);
  expect(ignore('/desktop/shared/workspace-management.ts')).toBe(false);
  execFileSync('node', ['--input-type=module', '-e', "await import('./desktop/lib/tools-menu.mts')"], { stdio: 'pipe' });
});
