import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { TerminalController } from './terminal-controller.mts';
import type { WorkspaceProjectStore } from './workspace-project-store.mts';

interface Options {
  ipc: Pick<IpcMain, 'handle'>;
  projects: WorkspaceProjectStore;
  controller(): TerminalController | null;
  available(): boolean;
  snapshot(): unknown;
  assertSender(event: IpcMainInvokeEvent): void;
}

/** Session mutations retain the pane's project regardless of later UI selection. */
export function registerWorkspaceTerminalIpc(options: Options): void {
  const handle = (name: string, action: Parameters<IpcMain['handle']>[1]) => {
    options.ipc.handle(`cheshi:${name}`, (event, ...args) => {
      options.assertSender(event);
      action(event, ...args);
      return options.snapshot();
    });
  };
  handle('new-terminal-session', (_event, projectId: unknown) => {
    const project = options.projects.get(projectId ?? 'primary');
    if (!project.available) throw new Error('The project folder is unavailable.');
    if (options.available()) options.controller()?.newSession(project.rootPath);
  });
  handle('select-terminal-session', (_event, sessionId) => options.controller()?.selectSession(sessionId));
  handle('close-terminal-session', (_event, sessionId) => options.controller()?.closeSession(sessionId));
  handle('select-terminal-pane', (_event, sessionId, paneId) => options.controller()?.selectPane(sessionId, paneId));
  handle('split-terminal-pane', (_event, sessionId, paneId, direction: unknown) => {
    if (direction === 'right' || direction === 'left' || direction === 'down' || direction === 'up') {
      options.controller()?.splitPane(sessionId, paneId, direction);
    }
  });
  handle('resize-terminal-split', (_event, sessionId, splitId, ratio) => {
    if (typeof splitId !== 'string' || !splitId.trim()) {
      throw new TypeError('Terminal split id must be a non-empty string.');
    }
    if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9) {
      throw new TypeError('Terminal split ratio must be between 0.1 and 0.9.');
    }
    options.controller()?.resizeSplit(sessionId, splitId.trim(), ratio);
  });
  handle('close-terminal-pane', (_event, sessionId, paneId) => options.controller()?.closePane(sessionId, paneId));
}
