import type { Clipboard, IpcMain, Shell } from 'electron';
import { getWorkspaceDiskUsage } from './workspace-disk-usage.mts';
import type { LocalHistoryService } from './local-history-service.mts';
import {
  createWorkspaceEntry,
  getWorkspaceEntryLocation,
  getWorkspaceFileVersion,
  listWorkspaceDirectory,
  moveWorkspaceEntry,
  readWorkspaceFile,
  readWorkspaceFileExcerpt,
  renameWorkspaceEntry,
  writeWorkspaceFile,
  writeWorkspaceFiles,
} from './workspace-file-service.mts';

interface WorkspaceFileIpcContext {
  ipcMain: Pick<IpcMain, 'handle'>;
  workspaceRoot: string;
  clipboard: Pick<Clipboard, 'writeText'>;
  shell: Pick<Shell, 'trashItem'>;
  localHistory?: Pick<LocalHistoryService, 'readFile' | 'writeFile' | 'writeFiles'>;
}

export function registerWorkspaceFileIpcHandlers({
  ipcMain,
  workspaceRoot,
  clipboard,
  shell,
  localHistory,
}: WorkspaceFileIpcContext) {
  ipcMain.handle('cheshi:get-workspace-disk-usage', () => getWorkspaceDiskUsage(workspaceRoot));
  ipcMain.handle(
    'cheshi:list-workspace-directory',
    (_event, relativePath) => listWorkspaceDirectory(workspaceRoot, relativePath, true),
  );
  ipcMain.handle('cheshi:read-workspace-file', (_event, relativePath) => localHistory
    ? localHistory.readFile(relativePath) : readWorkspaceFile(workspaceRoot, relativePath));
  ipcMain.handle(
    'cheshi:read-workspace-file-excerpt',
    (_event, request) => readWorkspaceFileExcerpt(workspaceRoot, request),
  );
  ipcMain.handle(
    'cheshi:get-workspace-file-version',
    (_event, relativePath) => getWorkspaceFileVersion(workspaceRoot, relativePath),
  );
  ipcMain.handle('cheshi:write-workspace-file', (_event, request) => localHistory
    ? localHistory.writeFile(request) : writeWorkspaceFile(workspaceRoot, request));
  ipcMain.handle('cheshi:write-workspace-files', (_event, request) => localHistory
    ? localHistory.writeFiles(request) : writeWorkspaceFiles(workspaceRoot, request));
  ipcMain.handle('cheshi:create-workspace-entry', (_event, request) => createWorkspaceEntry(workspaceRoot, request));
  ipcMain.handle('cheshi:rename-workspace-entry', (_event, request) => renameWorkspaceEntry(workspaceRoot, request));
  ipcMain.handle('cheshi:move-workspace-entry', (_event, request) => moveWorkspaceEntry(workspaceRoot, request));
  ipcMain.handle('cheshi:copy-workspace-entry-full-path', async (_event, relativePath) => {
    const location = await getWorkspaceEntryLocation(workspaceRoot, relativePath);
    clipboard.writeText(location.absolutePath);
    return location.absolutePath;
  });
  ipcMain.handle('cheshi:delete-workspace-entry', async (_event, relativePath) => {
    const location = await getWorkspaceEntryLocation(workspaceRoot, relativePath);
    await shell.trashItem(location.absolutePath);
    return { path: location.path };
  });
}
