import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { installRendererReadiness } from '../lib/renderer-readiness.mts';

const bootstrapSource = readFileSync(new URL('../bootstrap.mts', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../workspace-runtime.mts', import.meta.url), 'utf8');
const rendererHtml = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');

test('registers settings IPC before the renderer can request its initial menu state', () => {
  const createWindow = runtimeSource.indexOf('function createMainWindow(');
  const owner = runtimeSource.indexOf('options.scope.addOwner(window.webContents)', createWindow);
  const settingsReady = runtimeSource.indexOf('onWindowCreated?.(window)', owner);
  const loadRenderer = runtimeSource.indexOf('window.loadURL(rendererUrl)', createWindow);
  assert.ok(owner > createWindow);
  assert.ok(settingsReady > owner && settingsReady < loadRenderer);
  const mainSource = readFileSync(new URL('../main.mts', import.meta.url), 'utf8');
  assert.match(mainSource, /createWorkspaceRuntime\(\{\s*\.\.\.options,\s*getTypeSafeKey: apiSettings\.getKey\s*\},[\s\S]*?window => \{\s*settingsIpc = registerSettingsIpc\(/u);
  const start = mainSource.indexOf('const window = await runtime.start();', mainSource.indexOf('function createTrackedWorkspace('));
  assert.equal(mainSource.indexOf('registerSettingsIpc(', start), -1);
});

test('keeps the desktop window hidden until Electron and the painted renderer are ready', () => {
  const createWindow = runtimeSource.indexOf('function createMainWindow(');
  const hiddenWindow = runtimeSource.indexOf('show: false', createWindow);
  const rendererListener = runtimeSource.indexOf(
    'ipcMain.on(RENDERER_READY_CHANNEL, handleRendererReady)',
    createWindow,
  );
  const readyToShow = runtimeSource.indexOf(
    "window.once('ready-to-show', handleReadyToShow)",
    createWindow,
  );
  const loadRenderer = runtimeSource.indexOf('window.loadURL(rendererUrl)', createWindow);

  assert.ok(createWindow >= 0);
  assert.ok(hiddenWindow > createWindow);
  assert.ok(rendererListener > hiddenWindow);
  assert.ok(readyToShow > rendererListener);
  assert.ok(loadRenderer > readyToShow);
  assert.ok(runtimeSource.indexOf('await readiness.ready;', loadRenderer) > loadRenderer);
  assert.ok(runtimeSource.indexOf('if (!options.deferShow) revealWindow();', loadRenderer) > loadRenderer);
  assert.match(runtimeSource, /const shouldShowWindow = process\.env\.CHESHI_E2E_HEADLESS !== '1';/u);
  assert.match(runtimeSource, /window\.setBackgroundColor\(INITIAL_WINDOW_BACKGROUND_COLORS\[theme\]\);/u);
  assert.match(
    runtimeSource,
    /window\.loadFile\(path\.join\(frontendAssetsDirectory\(\), 'index\.html'\)\)/u,
  );
  assert.doesNotMatch(runtimeSource, /window\.once\('ready-to-show', showWindow\)/u);
});

function createRendererHarness(readyState: DocumentReadyState = 'loading') {
  const events = new EventTarget();
  const frames: FrameRequestCallback[] = [];
  const tasks: Array<() => void> = [];
  const themes: Array<'dark' | 'light'> = [];
  const documentElement = { dataset: { theme: 'dark' } };
  const document: Pick<Document, 'readyState' | 'documentElement'> = {
    readyState,
    documentElement: documentElement as unknown as HTMLElement,
  };
  const view: Pick<Window, 'addEventListener' | 'requestAnimationFrame' | 'setTimeout'> = {
    addEventListener: events.addEventListener.bind(events),
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    setTimeout(handler: TimerHandler, delay?: number, ...arguments_: unknown[]) {
      assert.equal(delay, 0);
      assert.equal(typeof handler, 'function');
      tasks.push(() => { if (typeof handler === 'function') handler(...arguments_); });
      return tasks.length;
    },
  };
  installRendererReadiness(view, document, (theme) => { themes.push(theme); });
  return {
    frames, tasks, themes, documentElement,
    dispatch(name: string) { events.dispatchEvent(new Event(name)); },
    frame() {
      const callback = frames.shift();
      assert.ok(callback, 'An animation frame must be queued');
      callback(0);
    },
    task() {
      const callback = tasks.shift();
      assert.ok(callback, 'A post-paint task must be queued');
      callback();
    },
  };
}

for (const firstEvent of ['DOMContentLoaded', 'cheshi:workspace-content-ready']) {
  test(`waits for both readiness events when ${firstEvent} arrives first`, () => {
    const renderer = createRendererHarness();
    renderer.dispatch(firstEvent);
    assert.equal(renderer.frames.length, 0);
    assert.equal(renderer.tasks.length, 0);
    assert.deepEqual(renderer.themes, []);

    renderer.dispatch(firstEvent === 'DOMContentLoaded' ? 'cheshi:workspace-content-ready' : 'DOMContentLoaded');
    assert.equal(renderer.frames.length, 1);
    assert.equal(renderer.tasks.length, 0);
    assert.deepEqual(renderer.themes, []);
    renderer.frame();
    assert.equal(renderer.frames.length, 1);
    assert.equal(renderer.tasks.length, 0);
    assert.deepEqual(renderer.themes, []);
    renderer.frame();
    assert.equal(renderer.frames.length, 0);
    assert.equal(renderer.tasks.length, 1);
    assert.deepEqual(renderer.themes, []);
    renderer.task();
    assert.deepEqual(renderer.themes, ['dark']);
  });
}

for (const readyState of ['interactive', 'complete'] as const) {
  test(`waits for workspace content when the document is already ${readyState}`, () => {
    const renderer = createRendererHarness(readyState);
    assert.equal(renderer.frames.length, 0);
    assert.deepEqual(renderer.themes, []);
    renderer.dispatch('cheshi:workspace-content-ready');
    renderer.frame();
    renderer.frame();
    renderer.task();
    assert.deepEqual(renderer.themes, ['dark']);
  });
}

test('duplicate readiness events produce exactly one post-paint notification', () => {
  const renderer = createRendererHarness();
  const dispatchReadyEvents = () => {
    renderer.dispatch('DOMContentLoaded');
    renderer.dispatch('cheshi:workspace-content-ready');
  };
  dispatchReadyEvents();
  dispatchReadyEvents();
  assert.equal(renderer.frames.length, 1);
  renderer.frame();
  dispatchReadyEvents();
  assert.equal(renderer.frames.length, 1);
  renderer.frame();
  dispatchReadyEvents();
  assert.equal(renderer.tasks.length, 1);
  renderer.task();
  dispatchReadyEvents();
  assert.equal(renderer.frames.length, 0);
  assert.equal(renderer.tasks.length, 0);
  assert.deepEqual(renderer.themes, ['dark']);
});

for (const [theme, expected] of [['light', 'light'], ['dark', 'dark'], ['invalid', 'dark']] as const) {
  test(`reads the current ${theme} theme when sending renderer readiness`, () => {
    const renderer = createRendererHarness();
    renderer.documentElement.dataset.theme = 'light';
    renderer.dispatch('DOMContentLoaded');
    renderer.dispatch('cheshi:workspace-content-ready');
    renderer.frame();
    renderer.frame();
    renderer.documentElement.dataset.theme = theme;
    renderer.task();
    assert.deepEqual(renderer.themes, [expected]);
  });
}

test('starts in dark mode without restoring a persisted light theme', () => {
  assert.match(rendererHtml, /<html[^>]+data-theme="dark"/u);
  assert.match(rendererHtml, /<meta name="theme-color" content="#171717"/u);
  assert.doesNotMatch(rendererHtml, /localStorage|data-cheshi-theme-bootstrap/u);
});


test('defers desktop service imports until the startup screen is visible', () => {
  const openStartup = bootstrapSource.indexOf('await startupScreen.open(');
  const cancellationGuard = bootstrapSource.indexOf('if (!shown || quitting) return;', openStartup);
  const initializeMain = bootstrapSource.indexOf("await import('./main.mts')", cancellationGuard);
  assert.ok(openStartup >= 0);
  assert.ok(cancellationGuard > openStartup);
  assert.ok(initializeMain > cancellationGuard);
  assert.doesNotMatch(bootstrapSource, /import\s+[^;]*from ['"]\.\/main\.mts['"]/u);
});

test('keeps the startup screen until the main window is revealed', () => {
  const createWindow = runtimeSource.indexOf('function createMainWindow(');
  const showWindow = runtimeSource.indexOf('window.show();', createWindow);
  const dismissStartup = runtimeSource.indexOf('startupScreen.close();', createWindow);
  assert.ok(createWindow >= 0);
  assert.ok(showWindow > createWindow);
  assert.ok(dismissStartup > showWindow);
});
