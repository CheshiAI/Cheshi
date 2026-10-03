import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import type { Menu, MenuItemConstructorOptions } from 'electron';
import { createHelpMenuAction, helpMenuTemplate } from '../lib/help-menu.mts';
import { createWorkspaceManagementApi } from '../lib/workspace-management-preload.cts';
import { OPEN_HELP_CHANNEL } from '../shared/workspace-management.ts';
import config from '../../forge.config.mts';

const buildMenu: typeof Menu.buildFromTemplate = items => ({ items }) as Menu;
function childrenOf(item: MenuItemConstructorOptions | Electron.MenuItem) {
  return (Array.isArray(item.submenu) ? item.submenu : item.submenu?.items ?? []) as MenuItemConstructorOptions[];
}

test('native help command preserves existing menus and opens help without duplicate entries', () => {
  let calls = 0;
  const edit: MenuItemConstructorOptions = { role: 'editMenu' };
  const other: MenuItemConstructorOptions = { label: 'Other help' };
  const result = helpMenuTemplate([edit, { role: 'help', submenu: [other] }], () => { calls++; }, buildMenu);
  expect(result[0]).toBe(edit);
  const children = childrenOf(result[1]!);
  expect(children.map(item => item.label)).toEqual(['Cheshi Help', 'Other help']);
  (children[0]!.click as () => void)(); expect(calls).toBe(1);
  const repeated = helpMenuTemplate(result, () => {}, buildMenu);
  expect(childrenOf(repeated[1]!).filter(item => item.id === 'cheshi-help')).toHaveLength(1);
  expect(helpMenuTemplate([edit], () => {}, buildMenu)[1]!.role).toBe('help');
});

function windowFixture() {
  const sent: string[] = [];
  const state = { destroyed: false, loading: false, shown: 0, focused: 0 };
  const window = {
    isDestroyed: () => state.destroyed, show: () => { state.shown++; }, focus: () => { state.focused++; },
    webContents: { isDestroyed: () => state.destroyed, isLoadingMainFrame: () => state.loading,
      send: (channel: string) => { sent.push(channel); } },
  };
  return { window, state, sent };
}

test('help targets the focused workspace and ignores auxiliary or closed windows', async () => {
  const first = windowFixture(), second = windowFixture();
  const auxiliary = windowFixture();
  let focused = second.window;
  const open = createHelpMenuAction({ focused: () => focused, windows: () => [first.window, second.window],
    openManager: async () => { throw new Error('Should use existing window'); } });
  await open(); expect(second.sent).toEqual([OPEN_HELP_CHANNEL]); expect(first.sent).toEqual([]);
  focused = auxiliary.window; first.state.destroyed = true;
  await open(); expect(second.sent).toHaveLength(2); expect(auxiliary.sent).toEqual([]);
  expect(second.state.focused).toBe(2);
});

test('help opens a manager once when no supported renderer is ready', async () => {
  const manager = windowFixture();
  let windows: typeof manager.window[] = [], opened = 0;
  const open = createHelpMenuAction({ focused: () => null, windows: () => windows,
    openManager: async () => { opened++; await Promise.resolve(); windows = [manager.window]; } });
  await Promise.all([open(), open()]);
  expect(opened).toBe(1); expect(manager.sent).toEqual([OPEN_HELP_CHANNEL]);
});

test('help preload buffers startup requests and removes renderer subscribers', () => {
  const ipc = Object.assign(new EventEmitter(), { invoke: async () => null });
  const api = createWorkspaceManagementApi(ipc);
  ipc.emit(OPEN_HELP_CHANNEL); let opened = 0;
  const unsubscribe = api.onHelpRequested!(() => { opened++; });
  expect(opened).toBe(1);
  ipc.emit(OPEN_HELP_CHANNEL); expect(opened).toBe(2);
  unsubscribe(); ipc.emit(OPEN_HELP_CHANNEL); expect(opened).toBe(2);
  const remove = api.onHelpRequested!(() => { opened++; });
  expect(opened).toBe(3); remove();
});

test('help menu and its shared contract are packaged and load with native Node', async () => {
  const ignore = (await config()).packagerConfig!.ignore;
  if (typeof ignore !== 'function') throw new Error('Expected package filter');
  expect(ignore('/desktop/lib/help-menu.mts')).toBe(false);
  expect(ignore('/desktop/shared/workspace-management.ts')).toBe(false);
  execFileSync('node', ['--input-type=module', '-e', "await import('./desktop/lib/help-menu.mts')"], { stdio: 'pipe' });
});
