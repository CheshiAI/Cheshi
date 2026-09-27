import path from 'node:path';
import { temporaryChatDraft } from '../shared/temporary-chat.ts';
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent, Shell } from 'electron';
import type { WorkspaceIpcScope } from './workspace-ipc-router.mts';
import { createTemporaryChatWindow } from './temporary-chat-window.mts';
import { TemporaryChatService } from './temporary-chat-service.mts';
import { registerTemporaryChatIpc } from './temporary-chat-ipc.mts';
import { registerLocalFileLinkIpc } from './local-file-link.mts';

/** Connects the workspace account to an isolated, non-persistent chat window. */
export function createWorkspaceTemporaryChat(options: {
  scope: WorkspaceIpcScope;
  getParent(): BrowserWindow | null;
  createWindow(configuration: BrowserWindowConstructorOptions): BrowserWindow;
  preload: string;
  appearanceFile: string;
  workspaceRoot: string;
  userName: string;
  wrapService?(service: Pick<TemporaryChatService, 'models' | 'send' | 'close'>, window: BrowserWindow): Pick<TemporaryChatService, 'models' | 'send' | 'close'>;
  createClient: ConstructorParameters<typeof TemporaryChatService>[0]['createClient'];
  selectFiles(window: BrowserWindow): Promise<string[]>;
  shell: Pick<Shell, 'openPath' | 'openExternal'>;
  onCleanupError(error: unknown): void;
}) {
  const manager = createTemporaryChatWindow({
    ...options,
    metadata: { workspaceRoot: options.workspaceRoot, workspaceName: path.basename(options.workspaceRoot), userName: options.userName },
    openExternal: url => options.shell.openExternal(url),
    registerSession: (scope, window) => {
      const assertSender = (event: IpcMainInvokeEvent) => {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
          throw new Error('Temporary chat sender is not its window.');
        }
      };
      registerLocalFileLinkIpc({ ipcMain: scope.ipc, workspaceRoot: options.workspaceRoot, shell: options.shell, assertSender });
      return registerTemporaryChatIpc({
        ipc: scope.ipc, assertSender,
        createService: () => {
          const service = new TemporaryChatService({ createClient: options.createClient, cwd: options.workspaceRoot });
          return options.wrapService?.(service, window) ?? service;
        },
        selectFiles: () => options.selectFiles(window), onCleanupError: options.onCleanupError,
      });
    },
  });
  const assertParent = (event: IpcMainInvokeEvent) => {
    const parent = options.getParent();
    if (!parent || event.sender !== parent.webContents || event.senderFrame !== parent.webContents.mainFrame) {
      throw new Error('Temporary chat can only be opened by its workspace.');
    }
  };
  options.scope.ipc.handle('cheshi:temporary-chat-open-window', (event, draft: unknown) => {
    assertParent(event); return manager.open(draft === undefined ? undefined : temporaryChatDraft(draft));
  });
  options.scope.ipc.handle('cheshi:temporary-chat-window-state', event => {
    assertParent(event); return manager.isOpen;
  });
  return manager;
}
