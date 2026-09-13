import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import type { GitHubRepositoryListResponse, WorkspaceManagementApi } from '../shared/workspace-management.ts';
import type { CheshiDesktopApi } from '../frontend/src/cheshiDesktop.ts';

test('built sandboxed preload exposes workspace actions through the intended IPC channels', async () => {
  let api: WorkspaceManagementApi | undefined;
  const calls: unknown[][] = [];
  let repositories: GitHubRepositoryListResponse = { status: 'ready', page: { repositories: [], nextPage: null, login: 'example' } };
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: process.platform },
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
    process: { platform: process.platform },
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
