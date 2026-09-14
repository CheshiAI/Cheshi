import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { AppUpdateApi, AppUpdateState } from '../shared/app-update';

interface TestElement {
  type: unknown;
  props: Record<string, unknown>;
}

function isElement(value: unknown): value is TestElement {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

function elements(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return isElement(value) ? [value, ...elements(value.props.children)] : [];
}

function content(value: unknown): string {
  if (Array.isArray(value)) return value.map(content).join('');
  if (isElement(value)) return content(value.props.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function find(value: unknown, predicate: (element: TestElement) => boolean): TestElement {
  const result = elements(value).find(predicate);
  assert.ok(result, 'Expected update UI element');
  return result;
}

function click(element: TestElement) {
  assert.equal(typeof element.props.onClick, 'function');
  (element.props.onClick as () => void)();
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

const available: AppUpdateState = {
  currentVersion: '0.0.1-alpha', phase: 'idle', error: null, installUnavailableReason: null,
  release: {
    version: '0.0.2-alpha', tag: 'v0.0.2-alpha', url: 'https://github.com/CheshiAI/Cheshi/releases/tag/v0.0.2-alpha',
    notes: '새 기능\n버그 수정',
    asset: { name: 'Cheshi-darwin-arm64.zip', url: 'https://github.com/CheshiAI/Cheshi/releases/download/v0.0.2-alpha/Cheshi-darwin-arm64.zip', size: 100, sha256: 'a'.repeat(64) },
  },
};

function harness(overrides: Partial<AppUpdateApi> = {}) {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const cleanups: (() => void)[] = [];
  let stateCursor = 0;
  let refCursor = 0;
  let mounted = false;
  let installCalls = 0;
  let releaseCalls = 0;
  let unsubscribed = false;
  let listener: ((state: AppUpdateState) => void) | undefined;
  const api: AppUpdateApi = {
    getAppUpdate: async () => available,
    onAppUpdate: callback => { listener = callback; return () => { unsubscribed = true; }; },
    installAppUpdate: async () => { installCalls++; },
    openAppRelease: async () => { releaseCalls++; },
    ...overrides,
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const index = stateCursor++;
        if (index >= states.length) states[index] = initial;
        return [states[index], (value: unknown) => { states[index] = value; }];
      },
      useRef(initial: unknown) {
        const index = refCursor++;
        refs[index] ??= { current: initial };
        return refs[index];
      },
      useEffect(effect: () => (() => void) | undefined) {
        if (mounted) return;
        const cleanup = effect();
        if (cleanup) cleanups.push(cleanup);
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'lucide-react': { Bell: 'Bell', ExternalLink: 'ExternalLink' },
    '../../cheshiDesktop': { cheshiDesktop: api },
    '../../shared/ui': {
      Modal: 'Modal', NeumorphicButton: 'NeumorphicButton',
      LoadingIndicator: 'LoadingIndicator', LoadingState: 'LoadingState',
    },
    './AppUpdateIndicator.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/updates/AppUpdateIndicator.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, Error, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const component = exports.AppUpdateIndicator;
  assert.ok(typeof component === 'function');
  return {
    render(): unknown { stateCursor = 0; refCursor = 0; const tree = component({ api }); mounted = true; return tree; },
    publish(state: AppUpdateState) { assert.ok(listener); listener(state); },
    unmount() { cleanups.forEach(cleanup => cleanup()); },
    get unsubscribed() { return unsubscribed; },
    get installCalls() { return installCalls; },
    get releaseCalls() { return releaseCalls; },
  };
}

function open(app: ReturnType<typeof harness>) {
  click(find(app.render(), element => element.props['aria-haspopup'] === 'dialog'));
}

test('shows the release only after detection and opens changelog on demand; cancel keeps the alert', async () => {
  const app = harness();
  expect(app.render()).toBe(null);
  await settle();
  expect(content(app.render())).toBe('Update available');
  expect(elements(app.render()).some(element => element.type === 'Modal')).toBe(false);
  open(app);
  const tree = app.render();
  expect(content(tree)).toContain('v0.0.1-alpha → v0.0.2-alpha');
  expect(content(tree)).toContain('새 기능\n버그 수정');
  click(find(tree, element => element.type === 'button' && content(element).startsWith('View full release')));
  await settle();
  expect(app.releaseCalls).toBe(1);
  click(find(tree, element => element.type === 'NeumorphicButton' && content(element) === 'Cancel'));
  expect(content(app.render())).toBe('Update available');
  expect(app.installCalls).toBe(0);
  app.unmount();
  expect(app.unsubscribed).toBe(true);
});

test('a late initial snapshot cannot replace a newer release or download event', async () => {
  const snapshot = createDeferred<AppUpdateState>();
  const app = harness({ getAppUpdate: () => snapshot.promise });
  app.render();
  app.publish({ ...available, phase: 'downloading' });
  snapshot.resolve({ ...available, release: null });
  await settle();
  expect(content(app.render())).toContain('Downloading');
  open(app);
  expect(find(app.render(), element => element.type === 'Modal').props.closeDisabled).toBe(true);
});

test('no release and startup request failures remain unobtrusive', async () => {
  const app = harness({ getAppUpdate: async () => { throw new Error('Offline'); } });
  app.render();
  await settle();
  expect(app.render()).toBe(null);
  app.publish({ ...available, release: null });
  expect(app.render()).toBe(null);
});

test('unavailable installation still shows release notes and explains the disabled update', async () => {
  const app = harness({ getAppUpdate: async () => ({ ...available, installUnavailableReason: 'Updates cannot be installed in development mode.' }) });
  app.render();
  await settle();
  open(app);
  const tree = app.render();
  expect(content(tree)).toContain('Updates cannot be installed in development mode.');
  const update = find(tree, element => element.type === 'NeumorphicButton' && content(element) === 'Update');
  expect(update.props.disabled).toBe(true);
  click(update);
  expect(app.installCalls).toBe(0);
});

test('duplicate installation is prevented and a failed installation remains retryable', async () => {
  const first = createDeferred<void>();
  let calls = 0;
  const app = harness({ installAppUpdate: () => { calls++; return calls === 1 ? first.promise : Promise.resolve(); } });
  app.render();
  await settle();
  open(app);
  const update = find(app.render(), element => element.type === 'NeumorphicButton' && content(element) === 'Update');
  click(update);
  click(update);
  expect(calls).toBe(1);
  expect(find(app.render(), element => element.type === 'LoadingState').props.label).toBe('Preparing update…');
  expect(elements(app.render()).some(element => element.type === 'LoadingIndicator')).toBe(true);
  expect(find(app.render(), element => element.type === 'Modal').props.closeDisabled).toBe(true);
  app.publish({ ...available, phase: 'downloading' });
  expect(find(app.render(), element => element.type === 'LoadingState').props.label).toBe('Downloading update…');
  app.publish({ ...available, phase: 'installing' });
  expect(find(app.render(), element => element.type === 'LoadingState').props.label).toBe('Installing the update and restarting…');
  app.publish({ ...available, error: 'Download interrupted' });
  first.reject(new Error('Download interrupted'));
  await settle();
  const failed = app.render();
  expect(elements(failed).some(element => element.type === 'LoadingState' || element.type === 'LoadingIndicator')).toBe(false);
  expect(content(find(failed, element => element.props.role === 'alert'))).toContain('Download interrupted');
  const retry = find(failed, element => element.type === 'NeumorphicButton' && content(element) === 'Update');
  expect(retry.props.disabled).toBe(false);
  click(retry);
  await settle();
  expect(calls).toBe(2);
});

test('release notes render as bounded plain text without executing supplied markup', async () => {
  assert.ok(available.release);
  const notes = '<script>alert(1)</script>\n' + 'x'.repeat(1_500);
  const app = harness({ getAppUpdate: async () => ({ ...available, release: { ...available.release!, notes } }) });
  app.render();
  await settle();
  open(app);
  const section = find(app.render(), element => element.props['aria-label'] === 'Release notes');
  const paragraph = find(section, element => element.type === 'p');
  expect(content(paragraph)).toHaveLength(1_201);
  expect(content(paragraph)).toStartWith('<script>alert(1)</script>');
  expect(elements(paragraph)).toHaveLength(1);
  expect(paragraph.props.dangerouslySetInnerHTML).toBeUndefined();
});

test('unexpected installation and release-link failures use English fallback messages', async () => {
  const app = harness({
    installAppUpdate: () => Promise.reject(null),
    openAppRelease: () => Promise.reject(null),
  });
  app.render();
  await settle();
  open(app);
  click(find(app.render(), element => element.type === 'NeumorphicButton' && content(element) === 'Update'));
  await settle();
  expect(content(find(app.render(), element => element.props.role === 'alert'))).toBe('Update failed. Please try again.');
  click(find(app.render(), element => element.type === 'button' && content(element).startsWith('View full release')));
  await settle();
  expect(content(find(app.render(), element => element.props.role === 'alert'))).toBe('Could not open the release page. Please try again.');
});

function previewSnapshot(): AppUpdateState {
  assert.ok(available.release);
  return {
    ...available,
    preview: true,
    release: { ...available.release, asset: null, notes: 'Preview release notes\n- Update dialog preview\n- Workspace recovery checks' },
  };
}

test('preview shows fake release notes without an asset, disables external release links, and preserves the alert on cancel', async () => {
  const app = harness({ getAppUpdate: async () => previewSnapshot() });
  app.render();
  await settle();
  open(app);
  const tree = app.render();
  expect(content(tree)).toContain('v0.0.1-alpha → v0.0.2-alpha');
  expect(content(tree)).toContain('Preview release notes\n- Update dialog preview\n- Workspace recovery checks');
  expect(content(tree)).toContain('Preview mode. No files will be downloaded or installed, and the app will not restart.');
  expect(content(tree)).not.toContain('The app will restart and restore your workspace.');
  expect(find(tree, element => element.type === 'button' && content(element).startsWith('View full release')).props.disabled).toBe(true);
  expect(find(tree, element => element.type === 'NeumorphicButton' && content(element) === 'Update').props.disabled).toBe(false);
  click(find(tree, element => element.type === 'NeumorphicButton' && content(element) === 'Cancel'));
  expect(content(app.render())).toContain('Update available');
  expect(elements(app.render()).some(element => element.type === 'Modal')).toBe(false);
  expect(app.installCalls).toBe(0);
  expect(app.releaseCalls).toBe(0);
});

test('preview update can simulate download and installation and remains retryable after a simulated failure', async () => {
  const update = createDeferred<void>();
  let calls = 0;
  const snapshot = previewSnapshot();
  const app = harness({
    getAppUpdate: async () => snapshot,
    installAppUpdate: () => { calls++; return calls === 1 ? update.promise : Promise.resolve(); },
  });
  app.render();
  await settle();
  open(app);
  click(find(app.render(), element => element.type === 'NeumorphicButton' && content(element) === 'Update'));
  expect(calls).toBe(1);
  app.publish({ ...snapshot, phase: 'downloading' });
  expect(find(app.render(), element => element.type === 'LoadingState').props.label).toBe('Preview: downloading update…');
  app.publish({ ...snapshot, phase: 'installing' });
  const installing = app.render();
  expect(find(installing, element => element.type === 'LoadingState').props.label).toBe('Preview: installing update…');
  expect(find(installing, element => element.type === 'Modal').props.closeDisabled).toBe(true);
  app.publish({ ...snapshot, error: 'Simulated update failure. No files were changed.' });
  update.reject(new Error('Simulated update failure. No files were changed.'));
  await settle();
  const failed = app.render();
  expect(content(find(failed, element => element.props.role === 'alert'))).toBe('Simulated update failure. No files were changed.');
  const retry = find(failed, element => element.type === 'NeumorphicButton' && content(element) === 'Update');
  expect(retry.props.disabled).toBe(false);
  click(retry);
  await settle();
  expect(calls).toBe(2);
  expect(app.releaseCalls).toBe(0);
});

test('a normal release without an installable asset cannot use the preview install exception', async () => {
  const snapshot = previewSnapshot();
  delete snapshot.preview;
  const app = harness({ getAppUpdate: async () => snapshot });
  app.render();
  await settle();
  open(app);
  const tree = app.render();
  expect(content(tree)).toContain('This release does not include an installable app.');
  const update = find(tree, element => element.type === 'NeumorphicButton' && content(element) === 'Update');
  expect(update.props.disabled).toBe(true);
  click(update);
  expect(app.installCalls).toBe(0);
});
