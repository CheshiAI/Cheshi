import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { BrowserWindowConstructorOptions } from 'electron';
import { ABOUT_CHANGELOG_URL, createAboutWindow, type AboutView } from '../lib/about-window.mts';

function createDeferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

class FakeContents extends EventEmitter {
  windowOpen: ((details: { url: string }) => { action: 'deny' }) | undefined;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void { this.windowOpen = handler; }
}

class FakeView extends EventEmitter implements AboutView {
  webContents = new FakeContents();
  load = createDeferred();
  destroyed = false;
  minimized = false;
  shows = 0;
  focuses = 0;
  restores = 0;
  closeError: Error | undefined;
  url = '';
  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean { return this.minimized; }
  restore(): void { this.restores++; this.minimized = false; }
  show(): void { this.shows++; }
  focus(): void { this.focuses++; }
  close(): void {
    if (this.closeError) throw this.closeError;
    this.destroy();
  }
  destroy(): void { this.destroyed = true; this.emit('closed'); }
  loadURL(url: string): Promise<void> { this.url = url; return this.load.promise; }
}

function fixture(openExternal?: (url: string) => Promise<void>) {
  const windows: FakeView[] = [];
  const configurations: BrowserWindowConstructorOptions[] = [];
  const errors: unknown[] = [];
  const externalUrls: string[] = [];
  const controller = createAboutWindow({
    title: 'About Cheshi',
    backgroundColor: '#1E2025',
    createWindow: (options) => {
      configurations.push(options);
      const view = new FakeView();
      windows.push(view);
      return view;
    },
    page: () => '<html><body>Cheshi</body></html>',
    openExternal: openExternal ?? (async url => { externalUrls.push(url); }),
    onError: (error) => errors.push(error),
  });
  return { controller, windows, configurations, errors, externalUrls };
}

test('opens a sandboxed local page only when ready and reuses the single window', () => {
  const { controller, windows, configurations } = fixture();
  controller.open();
  controller.open();
  assert.equal(windows.length, 1);
  const window = windows[0]!;
  assert.equal(window.shows, 0);
  assert.equal(decodeURIComponent(window.url.split(',')[1]!), '<html><body>Cheshi</body></html>');
  assert.deepEqual(configurations[0]!.webPreferences, { contextIsolation: true, sandbox: true, nodeIntegration: false });
  window.emit('ready-to-show');
  assert.equal(window.shows, 1);
  assert.equal(window.focuses, 1);
  window.minimized = true;
  controller.open();
  assert.equal(windows.length, 1);
  assert.equal(window.restores, 1);
  assert.equal(window.shows, 2);
});

test('blocks window creation and renderer navigation', () => {
  const { controller, windows } = fixture();
  controller.open();
  const contents = windows[0]!.webContents;
  assert.deepEqual(contents.windowOpen?.({ url: 'https://example.com' }), { action: 'deny' });
  let prevented = false;
  contents.emit('will-navigate', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test('opens only the fixed Cheshi changelog externally and keeps the About page in place', () => {
  const { controller, windows, externalUrls } = fixture();
  controller.open();
  const contents = windows[0]!.webContents;
  for (const url of [ABOUT_CHANGELOG_URL, 'https://example.com', `${ABOUT_CHANGELOG_URL}?other=true`, 'file:///tmp/CHANGELOG.md']) {
    assert.deepEqual(contents.windowOpen?.({ url }), { action: 'deny' });
    let prevented = false;
    contents.emit('will-navigate', { preventDefault() { prevented = true; } }, url);
    assert.equal(prevented, true);
  }
  assert.deepEqual(externalUrls, [ABOUT_CHANGELOG_URL, ABOUT_CHANGELOG_URL]);
  assert.equal(windows[0]!.destroyed, false);
});

test('reports external browser failures without closing the About window', async () => {
  const failure = new Error('Browser unavailable');
  const { controller, windows, errors } = fixture(async () => { throw failure; });
  controller.open();
  windows[0]!.webContents.windowOpen?.({ url: ABOUT_CHANGELOG_URL });
  await Promise.resolve();
  assert.deepEqual(errors, [failure]);
  assert.equal(windows[0]!.destroyed, false);
});

test('Escape and command W close the window without accepting ordinary W typing', () => {
  const { controller, windows } = fixture();
  for (const key of ['Escape', 'w']) {
    controller.open();
    const window = windows.at(-1)!;
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    window.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'w', meta: false, control: false });
    assert.equal(window.destroyed, false);
    window.webContents.emit('before-input-event', event, { type: 'keyDown', key, meta: key === 'w', control: false });
    assert.equal(window.destroyed, true);
    assert.equal(prevented, true);
  }
});

test('a failed page load destroys its window and allows retry', async () => {
  const { controller, windows, errors } = fixture();
  controller.open();
  const failure = new Error('load failed');
  windows[0]!.load.reject(failure);
  await Promise.resolve();
  assert.equal(windows[0]!.destroyed, true);
  assert.deepEqual(errors, [failure]);
  controller.open();
  assert.equal(windows.length, 2);
});

test('late events and a rejected load from a closed window cannot affect its replacement', async () => {
  const { controller, windows, errors } = fixture();
  controller.open();
  const old = windows[0]!;
  controller.close();
  controller.open();
  old.emit('closed');
  old.emit('ready-to-show');
  old.load.reject(new Error('closed while loading'));
  await Promise.resolve();
  controller.open();
  assert.equal(windows.length, 2);
  assert.equal(old.shows, 0);
  assert.deepEqual(errors, []);
  windows[1]!.emit('ready-to-show');
  assert.equal(windows[1]!.shows, 1);
});

test('dispose destroys even when close fails and prevents reopening', () => {
  const { controller, windows, errors } = fixture();
  controller.open();
  const failure = new Error('close failed');
  windows[0]!.closeError = failure;
  controller.dispose();
  controller.dispose();
  controller.open();
  assert.equal(windows[0]!.destroyed, true);
  assert.equal(windows.length, 1);
  assert.deepEqual(errors, [failure]);
});

test('page creation failure cleans up a created window', () => {
  const window = new FakeView();
  const errors: unknown[] = [];
  const failure = new Error('page failed');
  const controller = createAboutWindow({
    title: 'About Cheshi',
    backgroundColor: '#1E2025',
    createWindow: () => window,
    page: () => { throw failure; },
    openExternal: async () => {},
    onError: (error) => errors.push(error),
  });
  controller.open();
  assert.equal(window.destroyed, true);
  assert.deepEqual(errors, [failure]);
});
