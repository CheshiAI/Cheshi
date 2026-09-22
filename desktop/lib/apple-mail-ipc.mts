import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { AppleMailService } from './apple-mail-service.mts';

export function registerAppleMailIpc({ ipcMain, service, assertSender }: {
  ipcMain: Pick<IpcMain, 'handle'>; service: AppleMailService; assertSender: (event: IpcMainInvokeEvent) => void;
}): void {
  ipcMain.handle('cheshi:mail-mailboxes', event => { assertSender(event); return service.mailboxes(); });
  ipcMain.handle('cheshi:mail-list', (event, mailbox, offset) => { assertSender(event); return service.list(mailbox, offset); });
  ipcMain.handle('cheshi:mail-read', (event, target) => { assertSender(event); return service.read(target); });
  ipcMain.handle('cheshi:mail-accounts', event => { assertSender(event); return service.accounts(); });
  ipcMain.handle('cheshi:mail-change', (event, input) => { assertSender(event); return service.change(input); });
  ipcMain.handle('cheshi:mail-send', (event, input) => { assertSender(event); return service.send(input); });
}
