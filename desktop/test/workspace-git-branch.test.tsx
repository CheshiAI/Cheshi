import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { GitRepositorySnapshot } from '../frontend/src/cheshiDesktop';
import {
  observeWorkspaceGitBranch,
  workspaceGitBranchLabels,
} from '../frontend/src/features/shell/workspaceGitBranchModel';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function branch(head: string): GitRepositorySnapshot {
  return { available: true, message: '', head, detached: false };
}

function observer() {
  const requests: ReturnType<typeof createDeferred<GitRepositorySnapshot>>[] = [];
  const values: (GitRepositorySnapshot | null)[] = [];
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  let listener = () => {};
  let unsubscribed = false;
  const close = observeWorkspaceGitBranch({
    getGitSnapshot: () => {
      const request = createDeferred<GitRepositorySnapshot>();
      requests.push(request);
      return request.promise;
    },
    onGitRepositoryChanged: handler => {
      listener = handler;
      return () => { unsubscribed = true; };
    },
  }, value => { values.push(value); }, { window, document });
  return { requests, values, window, document, close, change: () => listener(),
    get unsubscribed() { return unsubscribed; } };
}

test('reads the initial branch and refreshes on repository changes without the Git view', async () => {
  const app = observer();
  try {
    expect(app.requests).toHaveLength(1);
    app.requests[0]!.resolve(branch('main'));
    await app.requests[0]!.promise;
    expect(app.values.at(-1)?.head).toBe('main');
    app.change();
    app.requests[1]!.resolve(branch('feature/next'));
    await app.requests[1]!.promise;
    expect(app.values.at(-1)?.head).toBe('feature/next');
  } finally { app.close(); }
});

test('coalesces rapid switches and discards a stale startup response', async () => {
  const app = observer();
  try {
    app.change();
    app.change();
    expect(app.requests).toHaveLength(1);
    app.requests[0]!.resolve(branch('old'));
    await app.requests[0]!.promise;
    expect(app.values).toEqual([]);
    expect(app.requests).toHaveLength(2);
    app.change();
    app.requests[1]!.resolve(branch('intermediate'));
    await app.requests[1]!.promise;
    expect(app.values).toEqual([]);
    app.requests[2]!.resolve(branch('latest'));
    await app.requests[2]!.promise;
    expect(app.values.map(value => value?.head)).toEqual(['latest']);
  } finally { app.close(); }
});

test('rechecks on focus and becoming visible, with no hidden focus refresh', async () => {
  const app = observer();
  try {
    app.requests[0]!.resolve(branch('main'));
    await app.requests[0]!.promise;
    app.document.visibilityState = 'hidden';
    app.document.dispatchEvent(new Event('visibilitychange'));
    app.window.dispatchEvent(new Event('focus'));
    expect(app.requests).toHaveLength(1);
    app.document.visibilityState = 'visible';
    app.document.dispatchEvent(new Event('visibilitychange'));
    app.requests[1]!.resolve(branch('external-switch'));
    await app.requests[1]!.promise;
    expect(app.values.at(-1)?.head).toBe('external-switch');
    app.window.dispatchEvent(new Event('focus'));
    expect(app.requests).toHaveLength(3);
  } finally { app.close(); }
});

test('clears an unavailable branch and recovers after a later change', async () => {
  const app = observer();
  try {
    app.requests[0]!.resolve(branch('main'));
    await app.requests[0]!.promise;
    app.change();
    app.requests[1]!.reject(new Error('Git read failed'));
    await app.requests[1]!.promise.catch(() => {});
    expect(app.values.at(-1)).toBeNull();
    app.change();
    app.requests[2]!.resolve(branch('recovered'));
    await app.requests[2]!.promise;
    expect(app.values.at(-1)?.head).toBe('recovered');
  } finally { app.close(); }
});

test('does not publish an obsolete failure when a newer refresh is queued', async () => {
  const app = observer();
  try {
    app.change();
    app.requests[0]!.reject(new Error('Obsolete read failed'));
    await app.requests[0]!.promise.catch(() => {});
    expect(app.values).toEqual([]);
    app.requests[1]!.resolve(branch('latest'));
    await app.requests[1]!.promise;
    expect(app.values.at(-1)?.head).toBe('latest');
  } finally { app.close(); }
});

test('unsubscribes on disposal and ignores pending responses and events', async () => {
  const app = observer();
  app.change();
  app.close();
  app.requests[0]!.resolve(branch('late'));
  await app.requests[0]!.promise;
  app.window.dispatchEvent(new Event('focus'));
  app.document.dispatchEvent(new Event('visibilitychange'));
  app.change();
  expect(app.unsubscribed).toBe(true);
  expect(app.values).toEqual([]);
  expect(app.requests).toHaveLength(1);
});

test('distinguishes branch, detached HEAD, unborn repository and unavailable states', () => {
  expect(workspaceGitBranchLabels(branch('feature/long-branch')).label).toBe('feature/long-branch');
  expect(workspaceGitBranchLabels({ ...branch('abc1234'), detached: true }).label).toBe('Detached · abc1234');
  expect(workspaceGitBranchLabels({ available: true, message: '', head: null }).label).toBe('No branch');
  expect(workspaceGitBranchLabels({ available: false, message: 'Not a Git worktree' }))
    .toEqual({ label: 'Git unavailable', title: 'Not a Git worktree' });
  expect(workspaceGitBranchLabels(null).label).toBe('Git unavailable');
});

test('renders branch updates with a full tooltip and cleans up its subscription', () => {
  const states: unknown[] = [];
  let cursor = 0;
  let effect: (() => void | (() => void)) | undefined;
  let receive: ((value: GitRepositorySnapshot | null) => void) | undefined;
  let disposed = false;
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      useState: (initial: unknown) => {
        const index = cursor++;
        if (index >= states.length) states.push(initial);
        return [states[index], (value: unknown) => { states[index] = value; }];
      },
      useEffect: (callback: () => void | (() => void)) => { effect = callback; },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': { GitBranch: 'GitBranch' },
    '../../cheshiDesktop': { cheshiDesktop: { getGitSnapshot: () => {}, onGitRepositoryChanged: () => {} } },
    './workspaceGitBranchModel': {
      workspaceGitBranchLabels,
      observeWorkspaceGitBranch: (_desktop: unknown, update: typeof receive) => {
        receive = update;
        return () => { disposed = true; };
      },
    },
    './WorkspaceGitBranch.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/shell/WorkspaceGitBranch.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, require: (name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const component = exports.WorkspaceGitBranch;
  assert.ok(typeof component === 'function');
  const render = () => {
    cursor = 0;
    return component() as { props: { title: string; 'aria-busy': boolean; children: { props: Record<string, unknown> }[] } };
  };
  expect(render().props['aria-busy']).toBe(true);
  const cleanup = effect?.();
  assert.ok(receive);
  receive(branch('feature/a-very-long-branch-name'));
  const tree = render();
  expect(tree.props.title).toBe('Current Git branch: feature/a-very-long-branch-name');
  expect(tree.props['aria-busy']).toBe(false);
  expect(tree.props.children[1]!.props.children).toBe('feature/a-very-long-branch-name');
  expect(tree.props.children[1]!.props['aria-live']).toBe('polite');
  receive(branch('main'));
  expect(render().props.children[1]!.props.children).toBe('main');
  assert.ok(cleanup);
  cleanup();
  expect(disposed).toBe(true);
});
