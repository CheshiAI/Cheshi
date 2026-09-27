import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent } from 'electron';
import { createTemporaryChatWindow } from '../lib/temporary-chat-window.mts';
import { WorkspaceIpcRouter } from '../lib/workspace-ipc-router.mts';
import { createWindowAppearance } from '../lib/window-appearance.mts';
import { registerTemporaryChatIpc } from '../lib/temporary-chat-ipc.mts';

class TestWindow extends EventEmitter {
  destroyed = false;
  shown = 0;
  focused = 0;
  restored = 0;
  minimized = false;
  url = 'http://localhost:5173/?workspace=fixture';
  zoom = 1.25;
  failLoad = false;
  sendReady = () => {};
  readonly messages: unknown[][] = [];
  readonly webContents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => this.destroyed,
    send: (...args: unknown[]) => { this.messages.push(args); },
    setWindowOpenHandler: () => {},
    getURL: () => this.url,
    setZoomFactor: (zoom: number) => { this.zoom = zoom; },
    getZoomFactor: () => this.zoom,
  });
  isDestroyed() { return this.destroyed; }
  getMinimumSize() { return [1280, 840]; }
  isMinimized() { return this.minimized; }
  restore() { this.restored++; this.minimized = false; }
  show() { this.shown++; }
  focus() { this.focused++; }
  setBackgroundColor() {}
  async loadURL(url: string) {
    this.url = url;
    if (this.failLoad) throw new Error('Load failed');
    this.emit('ready-to-show');
    this.sendReady();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.emit('destroyed');
    this.emit('closed');
  }
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-temporary-window-'));
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const listeners = new Map<string, Parameters<IpcMain['on']>[1]>();
  const ipc = {
    handle: (name: string, handler: Parameters<IpcMain['handle']>[1]) => { handlers.set(name, handler); },
    removeHandler: (name: string) => { handlers.delete(name); },
    on: (name: string, handler: Parameters<IpcMain['on']>[1]) => { listeners.set(name, handler); return ipc; },
    off: (name: string) => { listeners.delete(name); return ipc; },
  };
  const router = new WorkspaceIpcRouter(ipc as unknown as IpcMain);
  const parent = new TestWindow();
  const scope = router.createScope();
  scope.addOwner(parent.webContents as unknown as BrowserWindow['webContents']);
  scope.ipc.handle('persistent-chat', () => 'parent only');
  const windows: TestWindow[] = [];
  const configurations: BrowserWindowConstructorOptions[] = [];
  let closes = 0, failLoad = false;
  const errors: unknown[] = [];
  const manager = createTemporaryChatWindow({
    scope, getParent: () => parent as unknown as BrowserWindow,
    metadata: { workspaceRoot: '/fixture', workspaceName: 'fixture', userName: 'Tester' },
    preload: '/fixture/preload.cjs', appearanceFile: path.join(directory, 'appearance.json'),
    openExternal: async () => {}, onCleanupError: error => errors.push(error),
    createAppearance: options => createWindowAppearance({ ...options, binding: null }),
    createWindow: configuration => {
      configurations.push(configuration);
      const window = new TestWindow(); window.failLoad = failLoad;
      window.sendReady = () => listeners.get('cheshi:renderer-ready')?.({
        sender: window.webContents, senderFrame: window.webContents.mainFrame,
      } as unknown as Parameters<Parameters<IpcMain['on']>[1]>[0], 'dark');
      windows.push(window);
      return window as unknown as BrowserWindow;
    },
    registerSession: (childScope, window) => registerTemporaryChatIpc({
      ipc: childScope.ipc,
      assertSender: event => assert.equal(event.sender, window.webContents),
      selectFiles: async () => [], onCleanupError: error => errors.push(error),
      createService: () => ({ models: async () => [], send: async () => ({ text: 'Reply', model: 'test' }),
        close: async () => { closes++; } }),
    }),
  });
  const invoke = (window: TestWindow, channel: string, ...args: unknown[]) => handlers.get(channel)!({
    sender: window.webContents, senderFrame: window.webContents.mainFrame,
  } as unknown as IpcMainInvokeEvent, ...args);
  return { parent, windows, configurations, manager, invoke, errors, get closes() { return closes; },
    failLoad() { failLoad = true; },
    async dispose() { await manager.stop(); scope.dispose(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('opens one isolated window and focuses/restores it on repeated requests', async () => {
  const f = await fixture();
  try {
    await Promise.all([f.manager.open(), f.manager.open()]);
    assert.equal(f.windows.length, 1);
    const child = f.windows[0]!;
    assert.equal(new URL(child.url).searchParams.get('temporaryChat'), '1');
    assert.equal(new URL(child.url).searchParams.get('workspace'), 'fixture');
    assert.equal(child.zoom, f.parent.zoom);
    assert.equal(f.configurations[0]!.minWidth, 500);
    assert.equal(f.configurations[0]!.width, 500);
    assert.equal(f.configurations[0]!.minHeight, 840);
    assert.equal(f.configurations[0]!.height, 840);
    assert.equal(f.configurations[0]!.webPreferences?.sandbox, true);
    assert.equal(f.configurations[0]!.parent, undefined);
    child.minimized = true;
    await f.manager.open();
    assert.equal(child.restored, 1);
    assert.equal(child.focused, 2);
    assert.equal(f.windows.length, 1);
    assert.throws(() => f.invoke(child, 'persistent-chat'), /not authorized/);
    assert.throws(() => f.invoke(f.parent, 'cheshi:temporary-chat-models', 'invalid-owner'), /not authorized/);
    await f.invoke(child, 'cheshi:temporary-chat-models', 'session');
    assert.equal(f.manager.hasSessions, true);
    child.destroy();
    await f.manager.stop();
    assert.equal(f.closes, 1);
    assert.equal(f.manager.hasSessions, false);
    assert.deepEqual(f.parent.messages.at(-1), ['cheshi:temporary-chat-window-changed', false]);
    assert.deepEqual(f.errors, []);
  } finally { await f.dispose(); }
});

test('closing the parent ends the child session and reopening creates a fresh owner', async () => {
  const f = await fixture();
  try {
    await f.manager.open();
    await f.invoke(f.windows[0]!, 'cheshi:temporary-chat-models', 'first');
    f.windows[0]!.destroy();
    await f.manager.open();
    assert.equal(f.windows.length, 2);
    await f.invoke(f.windows[1]!, 'cheshi:temporary-chat-models', 'second');
    f.parent.destroy();
    await f.manager.stop();
    assert.equal(f.windows[1]!.destroyed, true);
    assert.equal(f.closes, 2);
  } finally { await f.dispose(); }
});

test('a failed load releases the window and its capabilities', async () => {
  const f = await fixture();
  try {
    f.failLoad();
    await assert.rejects(f.manager.open(), /Load failed/);
    assert.equal(f.windows[0]!.destroyed, true);
    assert.equal(f.manager.isOpen, false);
    assert.throws(() => f.invoke(f.windows[0]!, 'persistent-chat'), /not authorized/);
  } finally { await f.dispose(); }
});

test('renderer crashes end the temporary session', async () => {
  const f = await fixture();
  try {
    await f.manager.open();
    await f.invoke(f.windows[0]!, 'cheshi:temporary-chat-models', 'crashing');
    f.windows[0]!.webContents.emit('render-process-gone');
    await f.manager.stop();
    assert.equal(f.closes, 1);
    assert.equal(f.manager.isOpen, false);
  } finally { await f.dispose(); }
});
