import type { App, BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent } from 'electron';
import { realpath } from 'node:fs/promises';
import { GitHubAuthenticationRequiredError, GitHubRepositories } from './github-repositories.mts';
import type { GitHubRepositoryListResponse } from '../shared/workspace-management.ts';
import { GitHubLoginService } from './github-login-service.mts';
import { getWorkspaceToolStatus } from './workspace-tool-status.mts';
import { createWorkspaceCodexLoginService, type WorkspaceCodexLoginService } from './workspace-codex-login.mts';
import { WorkspaceManagementService } from './workspace-management-service.mts';
import { deleteRegisteredWorkspace } from './workspace-deletion.mts';
import { WorkspaceManagerWindow } from './workspace-manager-window.mts';
import type { WorkspaceManagerWindowOptions } from './workspace-manager-window.mts';

interface WorkspaceManagementIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>;
  app: Pick<App, 'getAppPath' | 'isPackaged'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>;
  trashItem: (root: string) => Promise<void>;
  withWorkspaceDeletion: (root: string, operation: () => Promise<boolean>) => Promise<boolean>;
  assertWorkspaceAvailable: (root: string) => void;
  getWindow: () => BrowserWindow | null;
  assertSender: (event: IpcMainInvokeEvent, feature: string) => void;
  dataRoot: string;
  github?: GitHubRepositories;
  githubLogin?: Pick<GitHubLoginService, 'start' | 'status' | 'cancel' | 'openBrowser' | 'dispose'>;
  createCodexLogin?: () => Pick<WorkspaceCodexLoginService, 'getStatus' | 'startLogin' | 'cancelLogin' | 'dispose'>;
  openExternal?: (url: string) => Promise<void>;
  onOpenWorkspace: (workspaceRoot: string) => Promise<void>;
  onReplaceWorkspace: (workspaceRoot: string) => Promise<void>;
  manager?: Pick<WorkspaceManagerWindowOptions, 'createWindow' | 'rendererUrl' | 'workspaceRoot' | 'onWindowCreated' | 'onShown' | 'readinessTimeoutMs'>;
}

export function registerWorkspaceManagementIpcHandlers(options: WorkspaceManagementIpcOptions): { open: () => Promise<void>; dispose: () => Promise<void> } {
  const github = options.github ?? new GitHubRepositories();
  const login = options.githubLogin ?? new GitHubLoginService({
    openExternal: options.openExternal ?? (async () => { throw new Error('Browser is unavailable.'); }),
  });
  const service = new WorkspaceManagementService(options.dataRoot, github, options.assertWorkspaceAvailable);
  let disposed = false;
  let codexLogin: ReturnType<NonNullable<WorkspaceManagementIpcOptions['createCodexLogin']>> | null = null;
  const closingCodex = new Set<Promise<void>>();
  const stopCodexLogin = (): Promise<void> => {
    const current = codexLogin;
    codexLogin = null;
    if (current) {
      const closing = current.dispose();
      closingCodex.add(closing);
      void closing.then(() => closingCodex.delete(closing), () => closingCodex.delete(closing));
    }
    return Promise.all([...closingCodex]).then(() => {});
  };
  const getCodexLogin = async (event: IpcMainInvokeEvent) => {
    await Promise.all([...closingCodex]);
    if (disposed || event.sender.isDestroyed()) throw new Error('Workspace management is closed.');
    return codexLogin ??= options.createCodexLogin?.() ?? createWorkspaceCodexLoginService({
      cwd: options.dataRoot,
      openExternal: options.openExternal ?? (async () => { throw new Error('Browser is unavailable.'); }),
    });
  };
  const manager = options.manager ? new WorkspaceManagerWindow({
    ...options.manager, appPath: options.app.getAppPath(),
    resourcesPath: process.resourcesPath, isPackaged: options.app.isPackaged,
    onWindowCreated: (window) => {
      options.manager?.onWindowCreated?.(window);
      window.once('closed', () => {
        login.cancel();
        void stopCodexLogin().catch(() => {});
      });
    },
  }) : null;
  const handle = (name: string, operation: (value: unknown, event: IpcMainInvokeEvent) => unknown) => {
    options.ipcMain.handle(`cheshi:workspace-management:${name}`, (event, value: unknown) => {
      if (disposed) throw new Error('Workspace management is closed.');
      if (!manager?.windowFor(event.sender)) options.assertSender(event, 'Workspace management');
      if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Workspace management requires the main window frame.');
      }
      return operation(value, event);
    });
  };
  handle('open-manager', () => {
    if (!manager) throw new Error('Workspace manager window is unavailable.');
    return manager.open();
  });
  handle('content-ready', (_value, event) => {
    if (!manager) throw new Error('Workspace manager window is unavailable.');
    manager.contentReady(event.sender);
  });
  handle('list', () => service.list());
  handle('get-tool-status', () => getWorkspaceToolStatus());
  handle('get-codex-login', async (_value, event) => (await getCodexLogin(event)).getStatus());
  handle('start-codex-login', async (_value, event) => (await getCodexLogin(event)).startLogin());
  handle('cancel-codex-login', async (_value, event) => (await getCodexLogin(event)).cancelLogin());
  handle('add-folder', (value) => service.addFolder(value));
  handle('create-project', (value) => service.createProject(value));
  handle('delete-workspace', async (id, event) => {
    const owner = manager?.windowFor(event.sender) ?? options.getWindow();
    if (!owner || owner.isDestroyed()) throw new Error('The workspace window is no longer available.');
    return deleteRegisteredWorkspace({
      id, dataRoot: options.dataRoot, protectedPaths: [options.app.getAppPath()],
      withDeletionLock: options.withWorkspaceDeletion,
      trashItem: options.trashItem,
      confirm: async (entry, exists) => {
        const { response } = await options.dialog.showMessageBox(owner, {
          type: 'warning', title: 'Delete workspace',
          message: exists ? `Move “${entry.name}” to Trash?` : `Remove “${entry.name}” from Workspaces?`,
          detail: exists
            ? `${entry.rootPath}\n\nThe entire project folder, including uncommitted files, and its CodeGraph index will be moved to Trash and removed from Workspaces. Chat history will be kept. You can restore the folder from Trash.`
            : `${entry.rootPath}\n\nThis folder no longer exists. Its CodeGraph index will be moved to Trash and its entry removed from Workspaces. Chat history will be kept.`,
          buttons: ['Cancel', exists ? 'Move to Trash' : 'Remove'], defaultId: 0, cancelId: 0, noLink: true,
        });
        return response === 1 && !owner.isDestroyed() && !event.sender.isDestroyed();
      },
    });
  });
  handle('clone', (value) => service.clone(value));
  handle('list-github-repositories', async (value): Promise<GitHubRepositoryListResponse> => {
    try { return { status: 'ready', page: await github.list(value) }; }
    catch (error) {
      if (error instanceof GitHubAuthenticationRequiredError) return { status: 'authentication-required' };
      throw error;
    }
  });
  handle('start-github-login', () => login.start());
  handle('get-github-login', () => login.status());
  handle('cancel-github-login', () => login.cancel());
  handle('open-github-login-browser', () => login.openBrowser());
  handle('list-worktrees', (value) => service.listWorktrees(value));
  handle('create-worktree', (value) => service.createWorktree(value));
  handle('choose-directory', async (_value, event) => {
    const owner = manager?.windowFor(event.sender) ?? options.getWindow();
    if (!owner || owner.isDestroyed()) throw new Error('The workspace window is no longer available.');
    const selection = await options.dialog.showOpenDialog(owner, {
      title: 'Select workspace folder', properties: ['openDirectory', 'createDirectory'],
    });
    return selection.canceled ? null : selection.filePaths[0] ?? null;
  });
  handle('open', async (value, event) => {
    const requester = manager?.windowFor(event.sender);
    const workspace = await service.addFolder(value);
    await options.onOpenWorkspace(workspace.rootPath);
    if (requester && !requester.isDestroyed()) requester.close();
  });
  let replacing = false;
  handle('open-current', async (value, event) => {
    if (replacing) throw new Error('A workspace switch is already in progress.');
    const owner = options.getWindow();
    if (!owner || owner.isDestroyed() || !options.manager) {
      throw new Error('The original workspace window is no longer available.');
    }
    replacing = true;
    const requester = manager?.windowFor(event.sender);
    try {
      const workspace = await service.addFolder(value);
      if (options.manager.workspaceRoot) assertDifferentWorkspace(workspace.rootPath, await realpath(options.manager.workspaceRoot));
      await options.onReplaceWorkspace(workspace.rootPath);
      if (requester && !requester.isDestroyed()) requester.close();
    } finally { replacing = false; }
  });
  return {
    open: async () => {
      if (!manager) throw new Error('Workspace manager window is unavailable.');
      await manager.open();
    },
    dispose: () => { disposed = true; login.dispose(); manager?.dispose(); return stopCodexLogin(); },
  };
}

function assertDifferentWorkspace(target: string, current: string): void {
  if (target === current) throw new Error('This workspace is already open in the original window.');
}
