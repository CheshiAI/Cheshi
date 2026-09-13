import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { shouldShowStartupScreen, StartupScreen, type StartupView } from '../lib/startup-screen.mts';
import { startupPage } from '../lib/startup-page.mts';

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

class FakeStartupView extends EventEmitter implements StartupView {
  destroyed = false;
  showCount = 0;
  destroyCount = 0;
  loadedUrl = '';
  scripts: string[] = [];
  load = createDeferred<void>();
  webContents = {
    executeJavaScript: async (script: string): Promise<unknown> => {
      this.scripts.push(script);
      return undefined;
    },
  };

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
  return screen.open(view, { name: 'Cheshi', version: '0.0.0', onCancel });
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
  assert.equal(view.showCount, 1);
  assert.equal(initialized, false);
  // Timers remain frozen: readiness alone must allow initialization to proceed.
  assert.equal(await opening, true);
  assert.equal(initialized, true);
  screen.close();
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
