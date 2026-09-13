import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { LocalHistoryService } from './local-history-service.mts';
import type { WorkspaceFilesChangedEvent } from './workspace-file-types.mts';

interface LocalHistoryIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>;
  service: Pick<LocalHistoryService, 'list' | 'read' | 'restore'>;
  assertSender: (event: IpcMainInvokeEvent) => void;
  onChanged: (event: WorkspaceFilesChangedEvent) => void;
}

export function registerLocalHistoryIpc({ ipcMain, service, assertSender, onChanged }: LocalHistoryIpcOptions): void {
  ipcMain.handle('cheshi:list-local-history', (event, path) => {
    assertSender(event);
    return service.list(path);
  });
  ipcMain.handle('cheshi:read-local-history', (event, path, id) => {
    assertSender(event);
    return service.read(path, id);
  });
  ipcMain.handle('cheshi:restore-local-history', async (event, request) => {
    assertSender(event);
    const result = await service.restore(request);
    if (result.status === 'written') onChanged({ paths: [result.file.path], overflow: false });
    return result;
  });
}
