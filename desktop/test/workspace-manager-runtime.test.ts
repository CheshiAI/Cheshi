import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { createWorkspaceManagerRuntime } from '../lib/workspace-manager-runtime.mts';
import { WorkspaceIpcRouter } from '../lib/workspace-ipc-router.mts';

type InvokeHandler = Parameters<IpcMain['handle']>[1];

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function fakeWindow(onLoad: () => void) {
  const events = new EventEmitter();
  const webEvents = new EventEmitter();
  const state = { destroyed: false, closes: 0, shows: 0, focuses: 0 };
  const webContents = {
    mainFrame: {}, isDestroyed: () => state.destroyed,
    on: webEvents.on.bind(webEvents), once: webEvents.once.bind(webEvents), off: webEvents.off.bind(webEvents),
    setWindowOpenHandler() {},
  } as unknown as WebContents;
  const destroy = () => {
    if (state.destroyed) return;
    state.destroyed = true;
    webEvents.emit('destroyed');
    events.emit('closed');
  };
  const window = {
    webContents, once: events.once.bind(events), off: events.off.bind(events),
    isDestroyed: () => state.destroyed, isMinimized: () => false,
    focus: () => { state.focuses += 1; },
    show: () => { state.shows += 1; },
    loadURL: async (_url: string) => { onLoad(); },
    loadFile: async (_file: string) => { onLoad(); },
    close: () => { state.closes += 1; destroy(); }, destroy,
  } as unknown as BrowserWindow;
  return { window, state, events, webEvents };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cheshi-manager-runtime-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const handlers = new Map<string, InvokeHandler>();
  const ipcEvents = new EventEmitter();
  const ipcMain = {
    handle: (channel: string, handler: InvokeHandler) => { handlers.set(channel, handler); },
    removeHandler: (channel: string) => { handlers.delete(channel); },
    on: ipcEvents.on.bind(ipcEvents), off: ipcEvents.off.bind(ipcEvents),
  } as Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'off'>;
  const scope = new WorkspaceIpcRouter(ipcMain).createScope();
  const owners: { contents: WebContents; managementOnly?: boolean }[] = [];
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const configurations: BrowserWindowConstructorOptions[] = [];
  const state = {
    shown: 0, closed: 0, loads: 0, scopeDisposed: 0,
    opened: [] as string[], replaced: [] as string[],
    openError: null as Error | null, replaceError: null as Error | null,
    operationGate: null as ReturnType<typeof createDeferred> | null,
    operationStarted: null as ReturnType<typeof createDeferred> | null,
  };
  const runtime = createWorkspaceManagerRuntime({
    workspaceRoot: root, managementOnly: true, initial: true,
    scope: {
      ipc: scope.ipc,
      addOwner: (contents, managementOnly) => {
        owners.push({ contents, managementOnly });
        scope.addOwner(contents, managementOnly);
      },
      dispose: () => { state.scopeDisposed += 1; scope.dispose(); },
    },
    onOpenWorkspace: async (target) => {
      state.opened.push(target);
      state.operationStarted?.resolve();
      await state.operationGate?.promise;
      if (state.openError) throw state.openError;
    },
    onReplaceWorkspace: async (target) => {
      state.replaced.push(target);
      state.operationStarted?.resolve();
      await state.operationGate?.promise;
      if (state.replaceError) throw state.replaceError;
    },
    withWorkspaceDeletion: async (_target, operation) => operation(),
    assertWorkspaceAvailable() {},
    onClosed: () => { state.closed += 1; },
  }, {
    app: { getAppPath: () => '/application/Cheshi', isPackaged: false },
    dataRoot: path.join(root, 'data'), rendererUrl: 'http://localhost:5173',
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    trashItem: async () => { throw new Error('Unexpected trash request'); },
    openExternal: async () => { throw new Error('Unexpected browser request'); },
    onShown: () => { state.shown += 1; },
    createWindow: (configuration) => {
      configurations.push(configuration);
      const created = fakeWindow(() => {
        state.loads += 1;
        assert.deepEqual(owners, [{ contents: created.window.webContents, managementOnly: true }]);
      });
      windows.push(created);
      return created.window;
    },
  });
  const eventFor = (sender = windows[0]!.window.webContents): IpcMainInvokeEvent => ({
    sender, senderFrame: sender.mainFrame,
  } as IpcMainInvokeEvent);
  const invoke = async (channel: string, value?: unknown, event = eventFor()) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `Missing handler: ${channel}`);
    return handler(event, value);
  };
  const startReady = async () => {
    const opening = runtime.start();
    windows.at(-1)!.events.emit('ready-to-show');
    await invoke('cheshi:workspace-management:content-ready');
    return opening;
  };
  return {
    startReady, root, workspace, scope, runtime, owners, windows, configurations, handlers, state, eventFor, invoke,
    cleanup: async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

test('project-free runtime owns one management window before loading and reports its lifecycle', async () => {
  const f = await fixture();
  try {
    const opening = f.runtime.start();
    const concurrent = f.runtime.start();
    assert.equal(f.windows.length, 1);
    assert.equal(f.state.loads, 1);
    assert.ok(f.configurations[0]!.webPreferences!.additionalArguments!.includes('--cheshi-manager-root='));
    assert.equal(f.state.shown, 0);
    assert.equal(f.windows[0]!.state.shows, 0);
    f.windows[0]!.events.emit('ready-to-show');
    assert.equal(f.state.shown, 0);
    assert.equal(f.windows[0]!.state.shows, 0);
    assert.equal(f.windows[0]!.state.focuses, 0);
    await f.invoke('cheshi:workspace-management:content-ready');
    const first = await opening;
    assert.equal(await concurrent, first);
    f.windows[0]!.events.emit('ready-to-show');
    assert.equal(f.state.shown, 1);
    assert.equal(f.windows[0]!.state.shows, 1);
    assert.equal(f.state.closed, 0);
    first.close();
    assert.equal(f.state.closed, 1);
    assert.equal(f.windows[0]!.webEvents.listenerCount('destroyed'), 0);
  } finally { await f.cleanup(); }
});

test('manager has only management capabilities and disposal releases its IPC scope', async () => {
  const f = await fixture();
  try {
    await f.startReady();
    assert.ok([...f.handlers.keys()].every((channel) => channel.startsWith('cheshi:workspace-management:')));
    f.scope.ipc.handle('cheshi:read-workspace-file', () => 'private project data');
    await assert.rejects(f.invoke('cheshi:read-workspace-file'), /not authorized/u);
    await assert.rejects(f.invoke('cheshi:workspace-management:list', undefined, {
      ...f.eventFor(), senderFrame: {},
    } as IpcMainInvokeEvent), /not authorized/u);
    await f.runtime.dispose();
    assert.equal(f.state.scopeDisposed, 1);
    assert.equal(f.windows[0]!.state.destroyed, true);
    assert.equal(f.state.closed, 1);
    assert.equal(f.handlers.size, 0);
    assert.throws(() => f.scope.ipc.handle('cheshi:test', () => null), /disposed/u);
    await assert.rejects(f.runtime.start(), /disposed/u);
  } finally { await f.cleanup(); }
});

for (const route of ['open', 'open-current'] as const) {
  test(`manager ${route} retains the chooser on failure and closes it only after a successful retry`, async () => {
    const f = await fixture();
    try {
      await f.startReady();
      const error = new Error('Workspace launch failed');
      if (route === 'open') f.state.openError = error;
      else f.state.replaceError = error;
      await assert.rejects(f.invoke(`cheshi:workspace-management:${route}`, f.workspace), /Workspace launch failed/u);
      assert.equal(f.windows[0]!.state.destroyed, false);
      assert.equal(f.windows[0]!.state.closes, 0);
      assert.equal(f.state.closed, 0);
      f.state.openError = null;
      f.state.replaceError = null;
      f.state.operationGate = createDeferred();
      f.state.operationStarted = createDeferred();
      const retry = f.invoke(`cheshi:workspace-management:${route}`, f.workspace);
      await f.state.operationStarted.promise;
      assert.equal(f.windows[0]!.state.closes, 0);
      f.state.operationGate.resolve();
      await retry;
      const target = await realpath(f.workspace);
      assert.deepEqual(f.state.opened, route === 'open' ? [target, target] : []);
      assert.deepEqual(f.state.replaced, route === 'open-current' ? [target, target] : []);
      assert.equal(f.windows[0]!.state.closes, 1);
      assert.equal(f.state.closed, 1);
      assert.equal(f.windows.length, 1);
    } finally { await f.cleanup(); }
  });
}
