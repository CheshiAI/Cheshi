import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { shouldShowStartupScreen, StartupScreen, type StartupView } from '../lib/startup-screen.mts';
import { startupPage } from '../lib/startup-page.mts';
import { DEFAULT_WINDOW_APPEARANCE } from '../shared/window-appearance.ts';
import { windowAppearanceStore } from '../lib/window-appearance-store.mts';
import type { WindowGlassBinding } from '../lib/window-appearance.mts';
import { loadForgeConfiguration } from './forge-test-helpers.ts';
import type { BrowserWindowConstructorOptions } from 'electron';
import { chatWindowOptions } from '../lib/chat-window-options.mts';
import { INITIAL_WINDOW_BACKGROUND_COLORS } from '../lib/window-appearance.mts';

test('startup enables native transparency and suppresses the top highlight before opening', () => {
  const bootstrap = readFileSync(new URL('../bootstrap.mts', import.meta.url), 'utf8');
  const start = bootstrap.indexOf('const window = new BrowserWindow(');
  const end = bootstrap.indexOf('const shown = await startupScreen.open(', start);
  assert.ok(start >= 0 && end > start);
  for (const platform of ['darwin', 'linux', 'win32']) {
    const highlighted: unknown[] = [];
    const options = runInNewContext(`${bootstrap.slice(start, end)}\nwindow.options;`, {
      BrowserWindow: class {
        readonly options: BrowserWindowConstructorOptions;
        webContents = { setWindowOpenHandler() {} };
        constructor(options: BrowserWindowConstructorOptions) { this.options = options; }
      },
      product: { displayName: 'Cheshi' },
      INITIAL_WINDOW_BACKGROUND_COLORS,
      createWindowTopHighlight: ({ window }: { window: unknown }) => { highlighted.push(window); },
      process: { platform },
    }) as BrowserWindowConstructorOptions;
    assert.equal(options.transparent, platform === 'darwin');
    assert.equal(options.show, false);
    assert.equal(highlighted.length, 1);
    assert.equal((highlighted[0] as { options: BrowserWindowConstructorOptions }).options, options);
    assert.equal(options.backgroundColor, INITIAL_WINDOW_BACKGROUND_COLORS.dark);
    if (platform === process.platform) assert.equal(options.transparent, chatWindowOptions('').transparent);
  }
});

test('shows splash on first launch but skips workspace windows and headless runs', () => {
  assert.equal(shouldShowStartupScreen({}), true);
  assert.equal(shouldShowStartupScreen({ CHESHI_WORKSPACE_WINDOW: '1' }), false);
  assert.equal(shouldShowStartupScreen({ CHESHI_E2E_HEADLESS: '1' }), false);
  assert.equal(shouldShowStartupScreen({ CHESHI_WORKSPACE_WINDOW: '0', CHESHI_E2E_HEADLESS: '0' }), true);
  assert.equal(shouldShowStartupScreen({ CHESHI_WORKSPACE_WINDOW: 'true' }), true);
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeStartupView extends EventEmitter {
  destroyed = false;
  showCount = 0;
  destroyCount = 0;
  loadedUrl = '';
  scripts: string[] = [];
  background = '';
  scriptResult: Promise<unknown> = Promise.resolve();
  load = createDeferred<void>();
  webContents = {
    isDestroyed: () => this.destroyed,
    executeJavaScript: async (script: string): Promise<unknown> => {
      this.scripts.push(script);
      return this.scriptResult;
    },
  };

  get boundary(): StartupView { return this as unknown as StartupView; }
  setBackgroundColor(value: string): void { this.background = value; }
  getNativeWindowHandle(): Buffer { return Buffer.alloc(8); }
  isDestroyed(): boolean { return this.destroyed; }
  show(): void { this.showCount += 1; }
  destroy(): void {
    this.destroyed = true;
    this.destroyCount += 1;
    this.emit('closed');
  }
  loadURL(url: string): Promise<void> {
    this.loadedUrl = url;
    return this.load.promise;
  }
}

function openScreen(screen: StartupScreen, view: FakeStartupView, onCancel = () => {}) {
  return screen.open(view.boundary, { name: 'Cheshi', version: '0.0.0', onCancel });
}

test('shows startup before allowing initialization to continue without a timer delay', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const screen = new StartupScreen();
  const view = new FakeStartupView();
  let initialized = false;
  const opening = openScreen(screen, view).then((shown) => {
    assert.equal(view.showCount, 1);
    initialized = shown;
    return shown;
  });
  view.load.resolve();
  await Promise.resolve();
  assert.equal(initialized, false);
  assert.equal(view.showCount, 0);

  view.emit('ready-to-show');
  assert.equal(initialized, false);
  // Timers remain frozen: readiness alone must allow initialization to proceed.
  assert.equal(await opening, true);
  assert.equal(initialized, true);
  screen.close();
});

test('reopening the splash waits for the new window readiness without a timer', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const screen = new StartupScreen();
  const first = new FakeStartupView();
  const opening = openScreen(screen, first);
  first.emit('ready-to-show');
  first.load.resolve();
  assert.equal(await opening, true);
  screen.close();
  assert.equal(screen.isOpen, false);
  const second = new FakeStartupView();
  const reopening = openScreen(screen, second);
  second.load.resolve();
  await Promise.resolve();
  assert.equal(second.showCount, 0);
  first.emit('ready-to-show');
  assert.equal(second.showCount, 0);
  second.emit('ready-to-show');
  assert.equal(await reopening, true);
  assert.equal(second.showCount, 1);
  second.destroy();
  assert.equal(screen.isOpen, false);
});

test('closing the startup window before readiness cancels initialization', async () => {
  const screen = new StartupScreen();
  const view = new FakeStartupView();
  let cancellations = 0;
  const opening = openScreen(screen, view, () => { cancellations += 1; });
  view.load.resolve();
  view.destroy();
  view.emit('ready-to-show');

  assert.equal(await opening, false);
  assert.equal(cancellations, 1);
  assert.equal(view.showCount, 0);
  screen.close();
  assert.equal(view.destroyCount, 1);
});

test('intentional close settles pending readiness without invoking cancellation', async () => {
  const screen = new StartupScreen();
  const view = new FakeStartupView();
  let cancellations = 0;
  const opening = openScreen(screen, view, () => { cancellations += 1; });
  view.load.resolve();
  screen.close();

  assert.equal(await opening, false);
  assert.equal(cancellations, 0);
  assert.equal(view.destroyCount, 1);
});

test('load rejection destroys the startup window and preserves the original error', async () => {
  const screen = new StartupScreen();
  const view = new FakeStartupView();
  const failure = new Error('startup document failed');
  let cancellations = 0;
  const opening = openScreen(screen, view, () => { cancellations += 1; });
  view.load.reject(failure);

  await assert.rejects(opening, (error: unknown) => error === failure);
  assert.equal(view.destroyCount, 1);
  assert.equal(cancellations, 0);
  await screen.setStatus('Loading');
  assert.deepEqual(view.scripts, []);
});

test('status updates preserve arbitrary text without interpreting markup or script', async () => {
  const screen = new StartupScreen();
  const view = new FakeStartupView();
  const opening = openScreen(screen, view);
  view.load.resolve();
  view.emit('ready-to-show');
  assert.equal(await opening, true);
  const message = '\"; globalThis.injected = true; //\n<img src=x onerror=alert(1)>\\';
  await screen.setStatus(message);
  const status = { textContent: '' };
  const sandbox = {
    document: { getElementById: (id: string) => {
      assert.equal(id, 'status');
      return status;
    } },
    injected: false,
  };
  runInNewContext(view.scripts[0]!, sandbox);
  assert.equal(status.textContent, message);
  assert.equal(sandbox.injected, false);
  screen.close();
  await screen.setStatus('After closing');
  assert.equal(view.scripts.length, 1);
});

test('startup document escapes product metadata and loads without external resources', async () => {
  const screen = new StartupScreen();
  const view = new FakeStartupView();
  const opening = openScreen(screen, view);
  assert.ok(view.loadedUrl.startsWith('data:text/html;charset=utf-8,'));
  assert.equal(decodeURIComponent(view.loadedUrl.split(',')[1]!), startupPage('Cheshi', '0.0.0'));
  const html = startupPage('<img src=x>', '\"<script>alert(1)</script>');
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(html.includes('&quot;&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.doesNotMatch(html, /<script|<img|https?:\/\//u);
  view.load.resolve();
  screen.close();
  assert.equal(await opening, false);
});

function appearanceHarness(context: TestContext, result: 'active' | 'reduced-transparency' | 'unsupported' | 'throw' = 'active') {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-startup-glass-'));
  const filename = path.join(directory, 'appearance.json');
  const preferences = { ...DEFAULT_WINDOW_APPEARANCE, opacity: .4, blurRadius: 24 };
  writeFileSync(filename, JSON.stringify(preferences));
  const screen = new StartupScreen();
  const view = new FakeStartupView();
  const nativeCalls: Array<{ enabled: boolean; radius: number }> = [];
  const binding: WindowGlassBinding = {
    windowGlassSupported: () => true,
    setWindowGlass(_handle, enabled, radius) {
      nativeCalls.push({ enabled, radius });
      if (!enabled) return 'disabled';
      if (result === 'throw') throw new Error('Native glass failed');
      return result;
    },
  };
  context.after(() => { screen.close(); rmSync(directory, { recursive: true, force: true }); });
  const opening = screen.open(view.boundary, {
    name: 'Cheshi', version: '0.0.0', appearanceFile: filename, appearanceBinding: binding, onCancel() {},
  });
  return { screen, view, opening, filename, preferences, nativeCalls };
}

function appliedAppearance(script: string) {
  const attributes = new Map<string, boolean>();
  const properties = new Map<string, string>();
  runInNewContext(script, { document: { documentElement: {
    toggleAttribute: (name: string, value: boolean) => { attributes.set(name, value); },
    style: { setProperty: (name: string, value: string) => { properties.set(name, value); } },
  } } });
  return { active: attributes.get('data-window-glass'), opacity: properties.get('--window-glass-opacity') };
}

async function waitForAppearance(view: FakeStartupView) {
  for (let attempt = 0; attempt < 20 && view.scripts.length === 0; attempt++) await Promise.resolve();
  assert.ok(view.scripts.length > 0, 'Appearance must be applied after document readiness');
}

test('applies saved native blur and shared surface opacity before showing startup', async context => {
  const h = appearanceHarness(context);
  const applied = createDeferred<unknown>();
  h.view.scriptResult = applied.promise;
  h.view.emit('ready-to-show');
  h.view.load.resolve();
  await waitForAppearance(h.view);
  assert.equal(h.view.showCount, 0);
  assert.deepEqual(h.nativeCalls.at(-1), { enabled: true, radius: 24 });
  assert.equal(h.view.background, '#00000000');
  assert.deepEqual(appliedAppearance(h.view.scripts.at(-1)!), { active: true, opacity: '0.4' });
  applied.resolve(undefined);
  assert.equal(await h.opening, true);
  assert.equal(h.view.showCount, 1);

  windowAppearanceStore(h.filename).save({ ...h.preferences, opacity: .6 });
  assert.deepEqual(appliedAppearance(h.view.scripts.at(-1)!), { active: true, opacity: '0.6' });
  windowAppearanceStore(h.filename).save({ ...h.preferences, enabled: false });
  assert.equal(h.view.background, '#000000');
  assert.equal(appliedAppearance(h.view.scripts.at(-1)!).active, false);
  h.screen.close();
  const count = h.view.scripts.length;
  windowAppearanceStore(h.filename).save(h.preferences);
  assert.equal(h.view.scripts.length, count);
  assert.equal(h.view.listenerCount('focus'), 0);
});

for (const result of ['reduced-transparency', 'unsupported', 'throw'] as const) {
  test(`startup uses the common opaque fallback when native glass reports ${result}`, async context => {
    const h = appearanceHarness(context, result);
    h.view.emit('ready-to-show');
    h.view.load.resolve();
    assert.equal(await h.opening, true);
    assert.equal(h.view.background, '#000000');
    assert.equal(appliedAppearance(h.view.scripts.at(-1)!).active, false);
    assert.equal(h.view.showCount, 1);
  });
}

test('closing while startup appearance is applying never reveals the closed window', async context => {
  const h = appearanceHarness(context);
  const applied = createDeferred<unknown>();
  h.view.scriptResult = applied.promise;
  h.view.emit('ready-to-show');
  h.view.load.resolve();
  await waitForAppearance(h.view);
  h.screen.close();
  applied.resolve(undefined);
  assert.equal(await h.opening, false);
  assert.equal(h.view.showCount, 0);
});

test('startup appearance application failures close the window and reject startup', async context => {
  const h = appearanceHarness(context);
  const applied = createDeferred<unknown>();
  h.view.scriptResult = applied.promise;
  h.view.emit('ready-to-show');
  h.view.load.resolve();
  await waitForAppearance(h.view);
  const rejection = assert.rejects(h.opening, /Renderer unavailable/u);
  applied.reject(new Error('Renderer unavailable'));
  await rejection;
  assert.equal(h.view.destroyCount, 1);
  assert.equal(h.view.showCount, 0);
  assert.equal(h.view.listenerCount('focus'), 0);
});

test('packaged startup retains shared glass styles and all appearance module dependencies', async () => {
  const configuration = await loadForgeConfiguration();
  const ignore = configuration.packagerConfig.ignore;
  assert.equal(typeof ignore, 'function');
  if (typeof ignore !== 'function') return;
  for (const file of [
    'desktop/bootstrap.mts', 'desktop/lib/startup-screen.mts', 'desktop/lib/startup-page.mts',
    'desktop/lib/window-appearance.mts', 'desktop/lib/window-appearance-store.mts',
    'desktop/shared/window-appearance.ts', 'desktop/frontend/src/shared/styles/tokens.css',
    'desktop/frontend/src/shared/styles/window-glass.css',
  ]) {
    const parts = file.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const entry = parts.slice(0, length).join('/');
      assert.equal(ignore(entry), false, `${entry} must be packaged`);
    }
  }
  assert.equal(ignore('desktop/frontend/src/styles.css'), true);
});
