import { expect, test } from 'bun:test';
import { act } from 'react';
import { WorkspaceManager } from '../frontend/src/features/navigation/workspace-management/WorkspaceManager';
import type { WorkspaceCatalog, WorkspaceCodexLoginState, WorkspaceManagementApi, WorkspaceToolStatus } from '../shared/workspace-management';
import { withDOM } from './agent-chats-test-dom';
import { createGitHubLoginApi } from './github-login-fixture';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('manager commits its loading screen before slow tools, login and catalog checks finish', async () => {
  await withDOM(async ui => {
    const previousEvent = globalThis.Event;
    globalThis.Event = window.Event;
    const tools = createDeferred<WorkspaceToolStatus>();
    const login = createDeferred<WorkspaceCodexLoginState>();
    const catalog = createDeferred<WorkspaceCatalog>();
    let signals = 0, lists = 0;
    const ready = () => { signals++; };
    window.addEventListener('cheshi:workspace-content-ready', ready);
    const entry = { id: 'test', name: 'Project', rootPath: '/test/project', available: true };
    const api: WorkspaceManagementApi = {
      ...createGitHubLoginApi(),
      getToolStatus: () => tools.promise, getCodexLogin: () => login.promise,
      startCodexLogin: async () => ({ state: 'signing_in', error: null }),
      cancelCodexLogin: async () => ({ state: 'signed_out', error: null }),
      list: () => { lists++; return catalog.promise; }, chooseDirectory: async () => null,
      deleteWorkspace: async () => false,
    removeWorkspace: async () => false,
      listGitHubRepositories: async () => ({ login: 'test', repositories: [], nextPage: null }),
      addFolder: async () => entry, createProject: async () => entry, clone: async () => entry,
      listWorktrees: async () => [], createWorktree: async () => entry,
      open: async () => {}, openCurrent: async () => {}, openManager: async () => {},
    };
    try {
      await ui.render(<WorkspaceManager api={api} workspaceName="Project" workspaceRoot={entry.rootPath} platform="darwin" />);
      expect(signals).toBe(1);
      expect(document.querySelector('h1')?.textContent).toBe('WORKSPACES');
      expect(document.body.textContent).toContain('Checking installed tools');
      expect(document.querySelector('input[aria-label="Search projects"]')).toBeNull();
      expect(lists).toBe(0);
      await act(async () => { tools.resolve({ platform: 'darwin', brew: true, gh: true, codex: true }); });
      expect(document.querySelector('[aria-label="Checking Codex sign-in"]')).not.toBeNull();
      expect(lists).toBe(0);
      await act(async () => { login.resolve({ state: 'signed_in', error: null }); });
      expect(lists).toBe(1);
      expect(document.querySelector('input[aria-label="Search projects"]')).toBeNull();
      await act(async () => { catalog.resolve({ workspaces: [entry] }); });
      expect(document.querySelector('input[aria-label="Search projects"]')).not.toBeNull();
      expect(document.querySelector('button[aria-label="Open Project"]')).not.toBeNull();
      expect(signals).toBe(1);
    } finally {
      window.removeEventListener('cheshi:workspace-content-ready', ready);
      globalThis.Event = previousEvent;
    }
  });
});
