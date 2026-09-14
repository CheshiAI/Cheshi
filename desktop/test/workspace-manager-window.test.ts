import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron';
import { WorkspaceManagerWindow } from '../lib/workspace-manager-window.mts';
import type { WorkspaceManagementApi } from '../shared/workspace-management.ts';

function createDeferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeWindow(load = Promise.resolve()) {
  const events = new EventEmitter();
  const webEvents = new EventEmitter();
  const state = {
    destroyed: false, minimized: false, shows: 0, focuses: 0, restores: 0,
    urls: [] as string[], files: [] as string[],
    openHandler: null as (() => { action: string }) | null,
  };
  const webContents = {
    on: webEvents.on.bind(webEvents),
    setWindowOpenHandler: (handler: () => { action: string }) => { state.openHandler = handler; },
  } as unknown as WebContents;
  const window = {
    webContents,
    once: events.once.bind(events), off: events.off.bind(events),
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    restore: () => { state.minimized = false; state.restores += 1; },
    focus: () => { state.focuses += 1; },
    show: () => { state.shows += 1; },
    loadURL: (url: string) => { state.urls.push(url); return load; },
    loadFile: (file: string) => { state.files.push(file); return load; },
    destroy: () => { state.destroyed = true; events.emit('closed'); },
  } as unknown as BrowserWindow;
  return { window, events, webEvents, state };
}

function harness(options: { isPackaged?: boolean; rendererUrl?: string; load?: Promise<void>; onWindowCreated?: (window: BrowserWindow) => void; readinessTimeoutMs?: number } = {}) {
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const configurations: BrowserWindowConstructorOptions[] = [];
  const manager = new WorkspaceManagerWindow({
    appPath: '/application/Cheshi', resourcesPath: '/application/Cheshi/Contents/Resources',
    isPackaged: options.isPackaged ?? false, rendererUrl: options.rendererUrl,
    workspaceRoot: '/work/체시 project', onWindowCreated: options.onWindowCreated,
    readinessTimeoutMs: options.readinessTimeoutMs,
    createWindow: (configuration) => {
      configurations.push(configuration);
      const created = fakeWindow(options.load);
      windows.push(created);
      return created.window;
    },
  });
  const openReady = async () => {
    const opening = manager.open();
    const current = windows.at(-1)!;
    current.events.emit('ready-to-show');
    manager.contentReady(current.window.webContents);
    await opening;
  };
  return { manager, windows, configurations, openReady };
}

test('manager stays hidden until ready and focuses a singleton, restoring minimized windows', async () => {
  const h = harness({ rendererUrl: 'http://localhost:5173' });
  const opening = h.manager.open();
  const first = h.windows[0]!;
  assert.equal(h.configurations[0]!.show, false);
  assert.equal(first.state.shows, 0);
  first.events.emit('ready-to-show');
  assert.equal(first.state.shows, 0);
  const concurrent = h.manager.open();
  assert.equal(first.state.focuses, 0);
  h.manager.contentReady(first.window.webContents);
  await Promise.all([opening, concurrent]);
  assert.equal(first.state.shows, 1);
  first.state.minimized = true;
  await h.openReady();
  assert.equal(h.windows.length, 1);
  assert.equal(first.state.restores, 1);
  assert.equal(first.state.focuses, 1);
  assert.equal(h.manager.windowFor(first.window.webContents), first.window);
  assert.equal(h.manager.windowFor({} as WebContents), null);
  first.window.destroy();
  assert.equal(h.manager.windowFor(first.window.webContents), null);
  await h.openReady();
  assert.equal(h.windows.length, 2);
});

test('concurrent opens share the pending load and failures destroy the window so it can be retried', async () => {
  const gate = createDeferred();
  const h = harness({ load: gate.promise });
  const first = h.manager.open();
  const second = h.manager.open();
  const failures = Promise.all([
    assert.rejects(first, /Load failed/u), assert.rejects(second, /Load failed/u),
  ]);
  assert.equal(h.windows.length, 1);
  gate.reject(new Error('Load failed'));
  await failures;
  assert.equal(h.windows[0]!.state.destroyed, true);
  assert.equal(h.manager.windowFor(h.windows[0]!.window.webContents), null);
  await assert.rejects(h.manager.open(), /Load failed/u);
  assert.equal(h.windows.length, 2);
});

test('closing before load completes rejects without showing an orphaned window', async () => {
  const gate = createDeferred();
  const h = harness({ load: gate.promise });
  const opening = h.manager.open();
  h.windows[0]!.window.destroy();
  h.windows[0]!.events.emit('ready-to-show');
  gate.resolve();
  await assert.rejects(opening, /closed before/u);
  assert.equal(h.windows[0]!.state.shows, 0);
});

test('dev and packaged managers resolve isolated preload and renderer locations', async () => {
  for (const isPackaged of [false, true]) {
    const h = harness({ isPackaged });
    await h.openReady();
    const preferences = h.configurations[0]!.webPreferences!;
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    const root = isPackaged ? '/application/Cheshi/Contents/Resources' : '/application/Cheshi/desktop';
    assert.equal(preferences.preload, `${root}/runtime/workspace-manager-preload.cjs`);
    assert.deepEqual(h.windows[0]!.state.files, [`${root}${isPackaged ? '' : '/frontend'}/dist/index.html`]);
    assert.deepEqual(preferences.additionalArguments, [
      `--cheshi-manager-root=${encodeURIComponent('/work/체시 project')}`,
      `--cheshi-manager-name=${encodeURIComponent('체시 project')}`,
    ]);
  }
  const dev = harness({ rendererUrl: 'http://localhost:5173' });
  await dev.openReady();
  assert.deepEqual(dev.windows[0]!.state.urls, ['http://localhost:5173']);
  assert.deepEqual(dev.windows[0]!.state.files, []);
});

test('manager prevents renderer navigation and additional renderer-created windows', async () => {
  const h = harness();
  await h.openReady();
  const first = h.windows[0]!;
  assert.deepEqual(first.state.openHandler?.(), { action: 'deny' });
  let prevented = false;
  first.webEvents.emit('will-navigate', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test('built manager preload exposes only management methods and decodes workspace metadata', async () => {
  const exposed = new Map<string, unknown>();
  const calls: { channel: string; value: unknown }[] = [];
  vm.runInNewContext(readFileSync(new URL('../runtime/workspace-manager-preload.cjs', import.meta.url), 'utf8'), {
    window: { addEventListener() {} }, document: { readyState: 'loading' },
    process: { platform: 'darwin', argv: [
      'electron', `--cheshi-manager-root=${encodeURIComponent('/work/체시 project')}`,
      `--cheshi-manager-name=${encodeURIComponent('체시 project')}`,
    ] },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key: string, value: unknown) => { exposed.set(key, value); } },
        ipcRenderer: { invoke: async (channel: string, value?: unknown) => {
          calls.push({ channel, value });
          if (channel === 'cheshi:workspace-management:list-github-repositories') {
            return { status: 'ready', page: { repositories: [], nextPage: null, login: 'example' } };
          }
          return null;
        } },
      };
    },
  });
  assert.deepEqual([...exposed.keys()], ['workspaceManager']);
  const bridge = exposed.get('workspaceManager') as {
    platform: string; workspaceRoot: string; workspaceName: string; api: WorkspaceManagementApi;
  };
  assert.equal(bridge.platform, 'darwin');
  assert.equal(bridge.workspaceRoot, '/work/체시 project');
  assert.equal(bridge.workspaceName, '체시 project');
  assert.deepEqual(Object.keys(bridge.api).sort(), [
    'addFolder', 'cancelCodexLogin', 'cancelGitHubLogin', 'chooseDirectory', 'clone', 'createWorktree', 'deleteWorkspace', 'getCodexLogin', 'getGitHubLogin', 'getToolStatus',
    'list', 'listGitHubRepositories', 'listWorktrees', 'open', 'openCurrent', 'openGitHubLoginBrowser', 'openManager', 'startCodexLogin', 'startGitHubLogin',
  ]);
  await bridge.api.list();
  await bridge.api.listGitHubRepositories(3);
  await bridge.api.open('/work/체시 project');
  await bridge.api.openCurrent('/work/other');
  assert.deepEqual(calls, [
    { channel: 'cheshi:workspace-management:list', value: undefined },
    { channel: 'cheshi:workspace-management:list-github-repositories', value: 3 },
    { channel: 'cheshi:workspace-management:open', value: '/work/체시 project' },
    { channel: 'cheshi:workspace-management:open-current', value: '/work/other' },
  ]);
});

test('manager preload accepts an empty root with Chromium switch normalization but rejects missing metadata', () => {
  const source = readFileSync(new URL('../runtime/workspace-manager-preload.cjs', import.meta.url), 'utf8');
  const load = (rootArgument?: string) => {
    let exposed: unknown;
    vm.runInNewContext(source, {
      window: { addEventListener() {} }, document: { readyState: 'loading' },
    process: { platform: 'darwin', argv: ['electron', '--cheshi-manager-name=Workspaces', ...(rootArgument ? [rootArgument] : [])] },
      require: () => ({
        contextBridge: { exposeInMainWorld: (_key: string, value: unknown) => { exposed = value; } },
        ipcRenderer: { invoke: async () => null },
      }),
    });
    return exposed as { workspaceRoot: string; workspaceName: string };
  };
  for (const argument of ['--cheshi-manager-root=', '--cheshi-manager-root']) {
    const bridge = load(argument);
    assert.equal(bridge.workspaceRoot, '');
    assert.equal(bridge.workspaceName, 'Workspaces');
  }
  assert.throws(() => load(), /metadata is unavailable/u);
});

test('registers the manager owner before renderer loading begins', async () => {
  let callbackCalls = 0;
  const h = harness({ onWindowCreated: (window) => {
    callbackCalls += 1;
    assert.equal(h.manager.windowFor(window.webContents), window);
    assert.deepEqual(h.windows[0]!.state.files, []);
    assert.deepEqual(h.windows[0]!.state.urls, []);
  } });
  await h.openReady();
  await h.openReady();
  assert.equal(callbackCalls, 1);
});

test('owner registration failure destroys the manager before loading its renderer', async () => {
  const h = harness({ onWindowCreated: () => { throw new Error('Scope disposed'); } });
  await assert.rejects(h.manager.open(), /Scope disposed/u);
  assert.equal(h.windows[0]!.state.destroyed, true);
  assert.deepEqual(h.windows[0]!.state.files, []);
  assert.equal(h.manager.windowFor(h.windows[0]!.window.webContents), null);
});

test('disposal destroys the pending manager and prevents it from being reopened or shown', async () => {
  const gate = createDeferred();
  const h = harness({ load: gate.promise });
  const opening = h.manager.open();
  h.manager.dispose();
  h.manager.dispose();
  const first = h.windows[0]!;
  first.events.emit('ready-to-show');
  gate.resolve();
  await assert.rejects(opening, /closed before/u);
  assert.equal(first.state.destroyed, true);
  assert.equal(first.state.shows, 0);
  assert.equal(h.manager.windowFor(first.window.webContents), null);
  await assert.rejects(h.manager.open(), /disposed/u);
  assert.equal(h.windows.length, 1);
});


test('content readiness before native paint stays hidden and only the current window can report it', async () => {
  const h = harness();
  const opening = h.manager.open();
  const first = h.windows[0]!;
  assert.throws(() => h.manager.contentReady({} as WebContents), /manager window/u);
  h.manager.contentReady(first.window.webContents);
  await Promise.resolve();
  assert.equal(first.state.shows, 0);
  first.events.emit('ready-to-show');
  await opening;
  h.manager.contentReady(first.window.webContents);
  assert.equal(first.state.shows, 1);
  h.manager.dispose();
});

test('startup readiness timeout rejects concurrent opens and never displays incomplete content', async () => {
  const h = harness({ readinessTimeoutMs: 10 });
  const first = h.manager.open();
  const second = h.manager.open();
  h.windows[0]!.events.emit('ready-to-show');
  await Promise.all([
    assert.rejects(first, /startup checks in time/u),
    assert.rejects(second, /startup checks in time/u),
  ]);
  assert.equal(h.windows[0]!.state.shows, 0);
  assert.equal(h.windows[0]!.state.destroyed, true);
  await h.openReady();
  assert.equal(h.windows.length, 2);
  h.manager.dispose();
});
