import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { AppleNotesService } from './apple-notes-service.mts';

export function registerAppleNotesIpc({ ipcMain, service, assertSender }: {
  ipcMain: Pick<IpcMain, 'handle'>;
  service: Pick<AppleNotesService, 'folders' | 'list' | 'read' | 'create'>;
  assertSender: (event: IpcMainInvokeEvent) => void;
}): void {
  ipcMain.handle('cheshi:apple-notes-folders', (event) => { assertSender(event); return service.folders(); });
  ipcMain.handle('cheshi:apple-notes-list', (event, folderId, offset) => { assertSender(event); return service.list(folderId, offset); });
  ipcMain.handle('cheshi:apple-notes-read', (event, noteId) => { assertSender(event); return service.read(noteId); });
  ipcMain.handle('cheshi:apple-notes-create', (event, input) => { assertSender(event); return service.create(input); });
}
