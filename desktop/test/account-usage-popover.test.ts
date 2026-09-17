import { EventEmitter } from 'node:events';
import { expect, test } from 'bun:test';
import type { IpcMainInvokeEvent, Rectangle } from 'electron';
import { createAccountUsagePopover, usagePopoverBounds } from '../lib/account-usage-popover.mts';
import { USAGE_POPOVER_CHANNEL as channel } from '../shared/account-usage-popover';

type Options = Parameters<typeof createAccountUsagePopover>[0];
type Handler = Parameters<Options['ipc']['handle']>[1];

function fixture() {
  const handlers = new Map<string, Handler>();
  const windows: ReturnType<typeof makeWindow>[] = [];
  const configurations: Parameters<Options['createWindow']>[0][] = [];
  const errors: unknown[] = [];
  let shown = 0;
  let quit = 0;
  let time = 1000;
  let failLoading = false;
  function makeWindow() {
    const window = Object.assign(new EventEmitter(), {
      destroyed: false, visible: false, bounds: null as Rectangle | null,
      webContents: Object.assign(new EventEmitter(), {
        mainFrame: {}, messages: [] as unknown[],
        send(topic: string, payload: unknown) { this.messages.push([topic, payload]); },
        setWindowOpenHandler(handler: () => { action: string }) { expect(handler()).toEqual({ action: 'deny' }); },
      }),
      isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; },
      show() { this.visible = true; }, hide() { this.visible = false; }, focus() {},
      destroy() { this.destroyed = true; this.visible = false; window.emit('closed'); },
      setBounds(bounds: Rectangle) { this.bounds = bounds; },
      async loadURL(url: string) { expect(url).toBe('file:///app/index.html'); if (failLoading) throw new Error('Load failed'); },
    });
    return window;
  }
  const popover = createAccountUsagePopover({
    createWindow(configuration) { const window = makeWindow(); windows.push(window); configurations.push(configuration); return window as unknown as ReturnType<Options['createWindow']>; },
    ipc: { handle(name, handler) { handlers.set(name, handler); }, removeHandler(name) { handlers.delete(name); } },
    getAnchor: () => ({ x: 990, y: 0, width: 24, height: 24 }),
    getWorkArea: () => ({ x: 0, y: 24, width: 1024, height: 700 }),
    rendererUrl: 'file:///app/index.html', preload: '/runtime/account-usage-preload.cjs',
    showApp() { shown++; }, quit() { quit++; }, onError(error) { errors.push(error); }, now: () => time,
  });
  function invoke(method: string, value?: unknown, event?: IpcMainInvokeEvent) {
    const window = windows.at(-1)!;
    return handlers.get(`${channel}:${method}`)!(event ?? {
      sender: window.webContents, senderFrame: window.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent, value);
  }
  return { popover, windows, handlers, configurations, errors, invoke,
    advance() { time += 250; }, failLoading() { failLoading = true; },
    get shown() { return shown; }, get quit() { return quit; } };
}

test('creates one sandboxed popover lazily, toggles it and hides on blur or Escape', () => {
  const f = fixture();
  expect(f.windows).toHaveLength(0);
  f.popover.toggle();
  const window = f.windows[0]!;
  expect(window.visible).toBe(false);
  window.emit('ready-to-show');
  expect(window.visible).toBe(true);
  expect(f.configurations[0]?.webPreferences).toEqual({ preload: '/runtime/account-usage-preload.cjs', sandbox: true, contextIsolation: true, nodeIntegration: false });
  f.popover.toggle(); expect(window.visible).toBe(false);
  f.popover.toggle(); expect(window.visible).toBe(true);
  window.emit('blur'); expect(window.visible).toBe(false);
  f.popover.toggle(); expect(window.visible).toBe(false);
  f.advance(); f.popover.toggle(); expect(window.visible).toBe(true);
  let prevented = false;
  window.webContents.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', key: 'Escape' });
  expect(prevented).toBe(true); expect(window.visible).toBe(false);
  expect(f.windows).toHaveLength(1);
  f.popover.dispose(); expect(window.destroyed).toBe(true); expect(f.handlers.size).toBe(0);
  f.popover.toggle(); expect(f.windows).toHaveLength(1);
});

test('updates existing account data and theme, and accepts IPC only from its main frame', () => {
  const f = fixture();
  f.popover.update({ activeId: 'a', profiles: [] }, false);
  f.popover.toggle();
  expect(f.invoke('read')).toMatchObject({ revision: 1, dark: false, snapshot: { activeId: 'a' } });
  f.popover.update({ activeId: 'b', profiles: [] }, true);
  expect(f.windows[0]!.webContents.messages.at(-1)).toEqual([`${channel}:changed`, { revision: 2, dark: true, snapshot: { activeId: 'b', profiles: [] } }]);
  for (const method of ['read', 'resize', 'action']) {
    expect(() => f.invoke(method, 'quit', {} as IpcMainInvokeEvent)).toThrow('Untrusted');
    expect(() => f.invoke(method, 'quit', { sender: f.windows[0]!.webContents, senderFrame: {} } as unknown as IpcMainInvokeEvent)).toThrow('Untrusted');
  }
  expect(f.quit).toBe(0);
  f.popover.dispose();
});

test('clamps size and position to the tray display and rejects malformed IPC', () => {
  expect(usagePopoverBounds({ x: -10, y: 0, width: 24, height: 24 }, { x: -1280, y: 24, width: 1280, height: 600 }, 1000))
    .toEqual({ x: -360, y: 24, width: 360, height: 600 });
  const f = fixture(); f.popover.toggle();
  f.invoke('resize', 500);
  expect(f.windows[0]!.bounds).toEqual({ x: 664, y: 28, width: 360, height: 500 });
  for (const value of [NaN, Infinity, -1, 0, 1.5, 10001, '500']) expect(() => f.invoke('resize', value)).toThrow('Invalid');
  expect(() => f.invoke('action', 'select')).toThrow('Invalid');
  f.popover.dispose();
});

test('Show Cheshi and Quit Cheshi hide the popover and invoke their original actions', () => {
  const f = fixture(); f.popover.toggle(); f.windows[0]!.emit('ready-to-show');
  f.invoke('action', 'show'); expect(f.shown).toBe(1); expect(f.windows[0]!.visible).toBe(false);
  f.popover.toggle(); f.invoke('action', 'quit'); expect(f.quit).toBe(1);
  f.popover.dispose();
});

test('blocks navigation and recovers from loading failures and renderer crashes', async () => {
  const f = fixture(); f.failLoading(); f.popover.toggle();
  let prevented = 0;
  for (const event of ['will-navigate', 'will-redirect']) f.windows[0]!.webContents.emit(event, { preventDefault() { prevented++; } });
  expect(prevented).toBe(2);
  await Promise.resolve();
  expect(f.errors).toHaveLength(1); expect(f.windows[0]!.destroyed).toBe(true);
  f.popover.toggle(); expect(f.windows).toHaveLength(2);
  f.windows[1]!.webContents.emit('render-process-gone');
  expect(f.windows[1]!.destroyed).toBe(true);
  f.popover.dispose();
});
