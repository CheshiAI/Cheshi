import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import type { GitHubRepositoryListResponse, WorkspaceManagementApi } from '../shared/workspace-management.ts';
import type { CheshiDesktopApi } from '../frontend/src/cheshiDesktop.ts';

const workspaceFilesChangedChannel = 'cheshi:workspace-files-changed';

function workspaceFileSubscriptions() {
  let api: Pick<CheshiDesktopApi, 'onWorkspaceFilesChanged'> | undefined;
  const ipc = Object.assign(new EventEmitter(), {
    sendSync: () => ({ workspaceName: 'Project', workspaceRoot: '/project' }),
    invoke: async () => null,
  });
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: process.platform, argv: [] },
    window: { addEventListener() {} },
    document: { readyState: 'loading' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        ipcRenderer: ipc,
        contextBridge: {
          exposeInMainWorld(key: string, value: Pick<CheshiDesktopApi, 'onWorkspaceFilesChanged'>) {
            if (key === 'cheshiDesktop') api = value;
          },
        },
      };
    },
  });
  assert.ok(api);
  return { ipc, subscribe: api.onWorkspaceFilesChanged };
}

test('file subscriptions share one IPC listener across many consumers and release it on unmount', () => {
  const { ipc, subscribe } = workspaceFileSubscriptions();
  const limit = ipc.getMaxListeners();
  assert.equal(ipc.listenerCount(workspaceFilesChangedChannel), 0);
  for (let cycle = 0; cycle < 20; cycle++) {
    const received = Array<number>(24).fill(0);
    const subscriptions = received.map((_, index) => subscribe(() => { received[index] = received[index]! + 1; }));
    try {
      assert.equal(ipc.listenerCount(workspaceFilesChangedChannel), 1);
      assert.equal(ipc.getMaxListeners(), limit);
      ipc.emit(workspaceFilesChangedChannel, {}, { paths: ['src/a.ts'], overflow: false });
      assert.deepEqual(received, Array<number>(24).fill(1));
      for (const unsubscribe of subscriptions.slice(0, 12)) { unsubscribe(); unsubscribe(); }
      assert.equal(ipc.listenerCount(workspaceFilesChangedChannel), 1);
      ipc.emit(workspaceFilesChangedChannel, {}, { paths: [], overflow: true });
      assert.deepEqual(received, [...Array<number>(12).fill(1), ...Array<number>(12).fill(2)]);
    } finally {
      for (const unsubscribe of subscriptions) unsubscribe();
    }
    assert.equal(ipc.listenerCount(workspaceFilesChangedChannel), 0);
  }
});

test('reusing a file callback creates independent subscriptions with idempotent cleanup', () => {
  const { ipc, subscribe } = workspaceFileSubscriptions();
  let calls = 0;
  const listener = () => { calls++; };
  const first = subscribe(listener);
  const second = subscribe(listener);
  ipc.emit(workspaceFilesChangedChannel, {}, { paths: [], overflow: true });
  assert.equal(calls, 2);
  first(); first();
  ipc.emit(workspaceFilesChangedChannel, {}, { paths: [], overflow: true });
  assert.equal(calls, 3);
  second();
  assert.equal(ipc.listenerCount(workspaceFilesChangedChannel), 0);
});

test('file event delivery preserves the current subscriber snapshot and isolates each payload', () => {
  const { ipc, subscribe } = workspaceFileSubscriptions();
  const received: string[] = [];
  const payload = { paths: ['src/a.ts', '/linked/b.ts'], overflow: false, privateData: 'not exposed' };
  let removeSecond = () => {};
  let removeLate = () => {};
  let firstEvent = true;
  const removeFirst = subscribe(event => {
    received.push('first');
    event.paths.push('consumer-only');
    event.overflow = true;
    if (firstEvent) {
      firstEvent = false;
      removeSecond();
      removeLate = subscribe(() => { received.push('late'); });
    }
  });
  removeSecond = subscribe(event => {
    received.push('second');
    assert.deepEqual(Array.from(event.paths), payload.paths);
    assert.equal(event.overflow, false);
    assert.deepEqual(Object.keys(event).sort(), ['overflow', 'paths']);
  });
  try {
    ipc.emit(workspaceFilesChangedChannel, { privateEvent: true }, payload);
    assert.deepEqual(received, ['first', 'second']);
    ipc.emit(workspaceFilesChangedChannel, {}, payload);
    assert.deepEqual(received, ['first', 'second', 'first', 'late']);
    assert.deepEqual(payload.paths, ['src/a.ts', '/linked/b.ts']);
    assert.equal(payload.overflow, false);
  } finally { removeFirst(); removeSecond(); removeLate(); }
  assert.equal(ipc.listenerCount(workspaceFilesChangedChannel), 0);
});

test('file subscriptions reject invalid handlers and retain bounded event validation', () => {
  const { ipc, subscribe } = workspaceFileSubscriptions();
  const subscribeUnknown = subscribe as (handler: unknown) => () => void;
  for (const handler of [null, undefined, {}, 'listener']) {
    assert.throws(() => subscribeUnknown(handler), /handler must be a function/u);
  }
  assert.equal(ipc.listenerCount(workspaceFilesChangedChannel), 0);
  let received = 0;
  const unsubscribe = subscribe(() => { received++; });
  try {
    for (const value of [null, [], {},
      { paths: 'src/a.ts', overflow: false }, { paths: Array<string>(513).fill('a'), overflow: false },
      { paths: [''], overflow: false }, { paths: [42], overflow: false },
      { paths: [], overflow: 1 }, { paths: [], overflow: 'false' },
    ]) {
      assert.throws(() => ipc.emit(workspaceFilesChangedChannel, {}, value), /must be/u);
    }
    assert.equal(received, 0);
    ipc.emit(workspaceFilesChangedChannel, {}, { paths: Array<string>(512).fill('a'), overflow: false });
    assert.equal(received, 1);
  } finally { unsubscribe(); }
  assert.equal(ipc.listenerCount(workspaceFilesChangedChannel), 0);
});

test('built sandboxed preload exposes workspace actions through the intended IPC channels', async () => {
  let api: WorkspaceManagementApi | undefined;
  const calls: unknown[][] = [];
  const menuListeners = new Map<string, () => void>();
  let repositories: GitHubRepositoryListResponse = { status: 'ready', page: { repositories: [], nextPage: null, login: 'example' } };
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: process.platform, argv: [] },
    window: { addEventListener() {} },
    document: { readyState: 'loading' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(key: string, value: { workspaceManagement?: WorkspaceManagementApi }) {
            if (key === 'cheshiDesktop') api = value.workspaceManagement;
          },
        },
        ipcRenderer: {
          on(channel: string, listener: () => void) { menuListeners.set(channel, listener); },
          sendSync() { return { workspaceName: 'Original', workspaceRoot: '/original' }; },
          invoke(...args: unknown[]) {
            calls.push(args);
            return Promise.resolve(args[0] === 'cheshi:workspace-management:list-github-repositories' ? repositories : null);
          },
        },
      };
    },
  });
  assert.ok(api);
  assert.equal('onVoiceRequested' in api, false);
  assert.equal(menuListeners.has('cheshi:open-voice'), false);
  let graphRequests = 0;
  menuListeners.get('cheshi:open-relationship-graph')?.();
  assert.ok(api.onRelationshipGraphRequested);
  const unsubscribeGraph = api.onRelationshipGraphRequested(() => { graphRequests++; });
  assert.equal(graphRequests, 1);
  menuListeners.get('cheshi:open-relationship-graph')?.();
  assert.equal(graphRequests, 2);
  unsubscribeGraph();
  menuListeners.get('cheshi:open-relationship-graph')?.();
  assert.equal(graphRequests, 2);
  const clone = { url: 'https://github.com/example/project.git', parentPath: '/projects', directoryName: 'project' };
  const project = { parentPath: '/projects', directoryName: 'new project' };
  const worktree = { repositoryPath: '/project', branch: 'feature/test', baseRef: 'main', directoryName: 'project-test' };
  await api.openManager();
  await api.list();
  await api.getToolStatus();
  await api.getCodexLogin();
  await api.startCodexLogin();
  await api.cancelCodexLogin();
  assert.deepEqual(await api.listGitHubRepositories(2), repositories.page);
  await api.startGitHubLogin();
  await api.getGitHubLogin();
  await api.openGitHubLoginBrowser();
  await api.cancelGitHubLogin();
  await api.chooseDirectory();
  await api.addFolder('/project');
  await api.createProject(project);
  await api.deleteWorkspace('registered-project-id');
  await api.removeWorkspace('registered-project-id');
  await api.clone(clone);
  await api.listWorktrees('/project');
  await api.createWorktree(worktree);
  await api.open('/project-test');
  await api.openCurrent('/project-other');
  assert.deepEqual(calls.map((call) => Array.from(call)), [
    ['cheshi:workspace-management:open-manager'],
    ['cheshi:workspace-management:list'],
    ['cheshi:workspace-management:get-tool-status'],
    ['cheshi:workspace-management:get-codex-login'],
    ['cheshi:workspace-management:start-codex-login'],
    ['cheshi:workspace-management:cancel-codex-login'],
    ['cheshi:workspace-management:list-github-repositories', 2],
    ['cheshi:workspace-management:start-github-login'],
    ['cheshi:workspace-management:get-github-login'],
    ['cheshi:workspace-management:open-github-login-browser'],
    ['cheshi:workspace-management:cancel-github-login'],
    ['cheshi:workspace-management:choose-directory'],
    ['cheshi:workspace-management:add-folder', '/project'],
    ['cheshi:workspace-management:create-project', project],
    ['cheshi:workspace-management:delete-workspace', 'registered-project-id'],
    ['cheshi:workspace-management:remove-workspace', 'registered-project-id'],
    ['cheshi:workspace-management:clone', clone],
    ['cheshi:workspace-management:list-worktrees', '/project'],
    ['cheshi:workspace-management:create-worktree', worktree],
    ['cheshi:workspace-management:open', '/project-test'],
    ['cheshi:workspace-management:open-current', '/project-other'],
  ]);
  repositories = { status: 'authentication-required' };
  await assert.rejects(api.listGitHubRepositories(), /Sign in to GitHub to browse your repositories/u);
});

test('built preload routes the nested local history API and preserves restore revisions', async () => {
  let api: CheshiDesktopApi['localHistory'] | undefined;
  const calls: unknown[][] = [];
  const entry = { id: 'history-id', path: 'src/note.txt', createdAt: 100, reason: 'saved', size: 6 };
  const snapshot = { entry, content: 'saved\n', hasBom: false, lineEnding: 'lf' };
  const restoreResult = { status: 'conflict', file: {
    path: entry.path, name: 'note.txt', kind: 'file', fileKind: 'text', size: 6,
    modifiedAt: 100, revision: 'newer-revision', hasBom: false, lineEnding: 'lf',
  } };
  const responses: Record<string, unknown> = {
    'cheshi:list-local-history': [entry],
    'cheshi:read-local-history': snapshot,
    'cheshi:restore-local-history': restoreResult,
  };
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: process.platform, argv: [] },
    window: { addEventListener() {} },
    document: { readyState: 'loading' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(key: string, value: Pick<CheshiDesktopApi, 'localHistory'>) {
            if (key === 'cheshiDesktop') api = value.localHistory;
          },
        },
        ipcRenderer: {
          sendSync() { return { workspaceName: 'Project', workspaceRoot: '/project' }; },
          async invoke(channel: string, ...args: unknown[]) {
            calls.push([channel, ...args]);
            return responses[channel];
          },
        },
      };
    },
  });
  assert.ok(api);
  const request = { path: entry.path, id: entry.id, expectedRevision: 'original-revision' };
  assert.deepEqual(await api.list(entry.path), [entry]);
  assert.equal(await api.read(entry.path, entry.id), snapshot);
  assert.equal(await api.restore(request), restoreResult);
  assert.deepEqual(calls, [
    ['cheshi:list-local-history', entry.path],
    ['cheshi:read-local-history', entry.path, entry.id],
    ['cheshi:restore-local-history', request],
  ]);
});
