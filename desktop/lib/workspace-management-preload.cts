import type { IpcRenderer } from 'electron';
import type { GitHubRepositoryListResponse, WorkspaceManagementApi } from '../shared/workspace-management.ts';

export function createWorkspaceManagementApi(ipc: Pick<IpcRenderer, 'invoke'>): WorkspaceManagementApi {
  return {
    getCodexLogin: () => ipc.invoke('cheshi:workspace-management:get-codex-login'),
    startCodexLogin: () => ipc.invoke('cheshi:workspace-management:start-codex-login'),
    cancelCodexLogin: () => ipc.invoke('cheshi:workspace-management:cancel-codex-login'),
    getToolStatus: () => ipc.invoke('cheshi:workspace-management:get-tool-status'),
    openManager: () => ipc.invoke('cheshi:workspace-management:open-manager'),
    list: () => ipc.invoke('cheshi:workspace-management:list'),
    chooseDirectory: () => ipc.invoke('cheshi:workspace-management:choose-directory'),
    addFolder: (path) => ipc.invoke('cheshi:workspace-management:add-folder', path),
    createProject: (request) => ipc.invoke('cheshi:workspace-management:create-project', request),
    deleteWorkspace: (id) => ipc.invoke('cheshi:workspace-management:delete-workspace', id),
    clone: (request) => ipc.invoke('cheshi:workspace-management:clone', request),
    listGitHubRepositories: async (page) => {
      const response: GitHubRepositoryListResponse = await ipc.invoke('cheshi:workspace-management:list-github-repositories', page);
      // Keep the renderer's existing login recovery flow without an Electron handler error.
      if (response.status === 'authentication-required') throw new Error('Sign in to GitHub to browse your repositories.');
      return response.page;
    },
    startGitHubLogin: () => ipc.invoke('cheshi:workspace-management:start-github-login'),
    getGitHubLogin: () => ipc.invoke('cheshi:workspace-management:get-github-login'),
    cancelGitHubLogin: () => ipc.invoke('cheshi:workspace-management:cancel-github-login'),
    openGitHubLoginBrowser: () => ipc.invoke('cheshi:workspace-management:open-github-login-browser'),
    listWorktrees: (path) => ipc.invoke('cheshi:workspace-management:list-worktrees', path),
    createWorktree: (request) => ipc.invoke('cheshi:workspace-management:create-worktree', request),
    open: (path) => ipc.invoke('cheshi:workspace-management:open', path),
    openCurrent: (path) => ipc.invoke('cheshi:workspace-management:open-current', path),
  };
}
