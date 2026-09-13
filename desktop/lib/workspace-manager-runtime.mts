import type { App, BrowserWindow, Dialog } from 'electron';
import type { WorkspaceRuntime, WorkspaceRuntimeOptions } from './workspace-application.mts';
import type { WorkspaceManagerWindowOptions } from './workspace-manager-window.mts';
import { registerWorkspaceManagementIpcHandlers } from './workspace-management-ipc.mts';

/** A project-free runtime with lazy account sign-in, no watchers, terminals or index workers. */
export function createWorkspaceManagerRuntime(options: WorkspaceRuntimeOptions, host: {
  app: Pick<App, 'getAppPath' | 'isPackaged'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>;
  dataRoot: string;
  createWindow: WorkspaceManagerWindowOptions['createWindow'];
  rendererUrl?: string;
  trashItem: (root: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  onShown: () => void;
}): WorkspaceRuntime {
  let window: BrowserWindow | null = null;
  const management = registerWorkspaceManagementIpcHandlers({
    ...host, ipcMain: options.scope.ipc, getWindow: () => window,
    assertSender: () => { throw new Error('Workspace manager sender is not authorized.'); },
    withWorkspaceDeletion: options.withWorkspaceDeletion,
    assertWorkspaceAvailable: options.assertWorkspaceAvailable,
    onOpenWorkspace: options.onOpenWorkspace,
    onReplaceWorkspace: options.onReplaceWorkspace,
    manager: {
      createWindow: host.createWindow, rendererUrl: host.rendererUrl, workspaceRoot: '',
      onShown: host.onShown,
      onWindowCreated: (created) => {
        window = created;
        options.scope.addOwner(created.webContents, true);
        created.once('closed', options.onClosed);
      },
    },
  });
  return {
    start: async () => {
      await management.open();
      if (!window || window.isDestroyed()) throw new Error('The workspace manager closed before it finished opening.');
      return window;
    },
    dispose: async () => { try { await management.dispose(); } finally { options.scope.dispose(); } },
  };
}
