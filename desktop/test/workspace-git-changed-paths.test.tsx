import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { CheshiDesktopApi, GitFileChange, GitRepositorySnapshot } from '../frontend/src/cheshiDesktop';

type GitApi = Pick<CheshiDesktopApi, 'getGitSnapshot' | 'onGitRepositoryChanged'>;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

function change(path: string, overrides: Partial<GitFileChange> = {}): GitFileChange {
  return {
    path, oldPath: null, indexStatus: ' ', workingTreeStatus: 'M',
    staged: false, unstaged: true, untracked: false, ...overrides,
  };
}

function snapshot(changes: GitFileChange[]): GitRepositorySnapshot {
  return { available: true, message: '', changes };
}

function eventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(name: string, listener: () => void) {
      const handlers = listeners.get(name) ?? new Set<() => void>();
      handlers.add(listener);
      listeners.set(name, handlers);
    },
    removeEventListener(name: string, listener: () => void) { listeners.get(name)?.delete(listener); },
    dispatch(name: string) { listeners.get(name)?.forEach(listener => listener()); },
    count(name: string) { return listeners.get(name)?.size ?? 0; },
  };
}

function harness(getSnapshot: GitApi['getGitSnapshot'], available = true) {
  const states: unknown[] = [];
  const effects: (() => void | (() => void))[] = [];
  const cleanups: (() => void)[] = [];
  const window = eventTarget();
  const document = { ...eventTarget(), visibilityState: 'visible' };
  let cursor = 0;
  let mounted = false;
  let calls = 0;
  let writes = 0;
  let listener: (() => void) | undefined;
  const api: GitApi = {
    getGitSnapshot: () => { calls++; return getSnapshot(); },
    onGitRepositoryChanged(callback) {
      listener = callback;
      return () => { listener = undefined; };
    },
  };
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (index >= states.length) states[index] = typeof initial === 'function' ? initial() : initial;
        return [states[index], (value: unknown) => {
          writes++;
          states[index] = typeof value === 'function' ? value(states[index]) : value;
        }];
      },
      useEffect(effect: () => void | (() => void)) { if (!mounted) effects.push(effect); },
    },
    '../../cheshiDesktop': { cheshiDesktop: available ? api : undefined },
  };
  const source = readFileSync(new URL('../frontend/src/features/navigation/useWorkspaceGitChangedPaths.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, {
    exports, window, document, Set,
    require(name: string) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
      return modules[name];
    },
  });
  const hook = exports.useWorkspaceGitChangedPaths;
  assert.ok(typeof hook === 'function');
  return {
    render(): ReadonlySet<string> {
      cursor = 0;
      const paths: unknown = hook();
      assert.ok(paths instanceof Set);
      assert.ok([...paths].every(path => typeof path === 'string'));
      if (!mounted) {
        mounted = true;
        for (const effect of effects) {
          const cleanup = effect();
          if (cleanup) cleanups.push(cleanup);
        }
      }
      return paths;
    },
    publish() { listener?.(); },
    focus() { window.dispatch('focus'); },
    visibility(state: string) { document.visibilityState = state; document.dispatch('visibilitychange'); },
    unmount() { cleanups.forEach(cleanup => cleanup()); },
    get calls() { return calls; },
    get writes() { return writes; },
    get subscribed() { return listener !== undefined; },
    get focusListeners() { return window.count('focus'); },
    get visibilityListeners() { return document.count('visibilitychange'); },
  };
}

test('loads staged, unstaged, untracked, renamed and conflicted file paths once on mount', async () => {
  const app = harness(async () => snapshot([
    change('staged.ts', { staged: true, unstaged: false, indexStatus: 'M', workingTreeStatus: ' ' }),
    change('unstaged.ts'),
    change('untracked.ts', { untracked: true, indexStatus: '?', workingTreeStatus: '?' }),
    change('renamed.ts', { staged: true, oldPath: 'original.ts', indexStatus: 'R' }),
    change('conflicted.ts', { indexStatus: 'U', workingTreeStatus: 'U' }),
  ]));
  expect([...app.render()]).toEqual([]);
  await settle();
  expect([...app.render()]).toEqual(['staged.ts', 'unstaged.ts', 'untracked.ts', 'renamed.ts', 'conflicted.ts']);
  app.render();
  expect(app.calls).toBe(1);
  app.unmount();
});

test('refreshes Git events and removes paths when their changes are cleared', async () => {
  let current = snapshot([change('changed.ts')]);
  const app = harness(async () => current);
  app.render();
  await settle();
  expect([...app.render()]).toEqual(['changed.ts']);
  current = snapshot([]);
  app.publish();
  await settle();
  expect([...app.render()]).toEqual([]);
  expect(app.calls).toBe(2);
  app.unmount();
});

test('refreshes on window focus and visibility restoration but not when becoming hidden', async () => {
  let current = snapshot([]);
  const app = harness(async () => current);
  app.render();
  await settle();
  current = snapshot([change('external-edit.ts')]);
  app.focus();
  await settle();
  expect([...app.render()]).toEqual(['external-edit.ts']);
  app.visibility('hidden');
  await settle();
  expect(app.calls).toBe(2);
  current = snapshot([change('visible-edit.ts')]);
  app.visibility('visible');
  await settle();
  expect([...app.render()]).toEqual(['visible-edit.ts']);
  expect(app.calls).toBe(3);
  app.unmount();
});

test('coalesces events during an in-flight request and applies the subsequent snapshot', async () => {
  const first = createDeferred<GitRepositorySnapshot>();
  const second = createDeferred<GitRepositorySnapshot>();
  let requests = 0;
  const app = harness(() => ++requests === 1 ? first.promise : second.promise);
  app.render();
  app.publish();
  app.publish();
  app.focus();
  expect(app.calls).toBe(1);
  first.resolve(snapshot([change('old.ts')]));
  await settle();
  expect(app.calls).toBe(2);
  second.resolve(snapshot([change('latest.ts')]));
  await settle();
  expect([...app.render()]).toEqual(['latest.ts']);
  expect(app.calls).toBe(2);
  app.unmount();
});

test('keeps the last successful paths on failure and clears them when Git is unavailable', async () => {
  let current = snapshot([change('retained.ts')]);
  let fail = false;
  const app = harness(async () => {
    if (fail) throw new Error('Git temporarily unavailable');
    return current;
  });
  app.render();
  await settle();
  fail = true;
  app.publish();
  await settle();
  expect([...app.render()]).toEqual(['retained.ts']);
  fail = false;
  current = { ...current, available: false };
  app.publish();
  await settle();
  expect([...app.render()]).toEqual([]);
  current = { available: true, message: '' };
  app.publish();
  await settle();
  expect([...app.render()]).toEqual([]);
  app.unmount();
});

test('unmount removes listeners and ignores late responses without starting queued refreshes', async () => {
  const pending = createDeferred<GitRepositorySnapshot>();
  const app = harness(() => pending.promise);
  app.render();
  expect(app.subscribed).toBe(true);
  expect(app.focusListeners).toBe(1);
  expect(app.visibilityListeners).toBe(1);
  app.publish();
  app.unmount();
  expect(app.subscribed).toBe(false);
  expect(app.focusListeners).toBe(0);
  expect(app.visibilityListeners).toBe(0);
  pending.resolve(snapshot([change('late.ts')]));
  await settle();
  app.publish();
  app.focus();
  app.visibility('visible');
  expect(app.calls).toBe(1);
  expect(app.writes).toBe(0);
});

test('without the desktop bridge the hook stays empty and registers no listeners', async () => {
  const app = harness(async () => snapshot([change('unused.ts')]), false);
  expect([...app.render()]).toEqual([]);
  await settle();
  expect([...app.render()]).toEqual([]);
  expect(app.calls).toBe(0);
  expect(app.focusListeners).toBe(0);
  expect(app.visibilityListeners).toBe(0);
  app.unmount();
});
