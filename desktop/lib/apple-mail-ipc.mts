import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { AppleMailService } from './apple-mail-service.mts';
import { mailFailure } from '../shared/apple-mail.ts';
import type { MailReplyAssistant } from './mail-reply-assistant.mts';

export function registerAppleMailIpc({ ipcMain, service, assertSender, assistant, beforePolish }: {
  ipcMain: Pick<IpcMain, 'handle'>; service: AppleMailService; assertSender: (event: IpcMainInvokeEvent) => void;
  assistant?: MailReplyAssistant; beforePolish?(): Promise<void>;
}): void {
  ipcMain.handle('cheshi:mail-polish', async (event, input) => {
    assertSender(event);
    if (!assistant) return mailFailure('editing-failed');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const navigate = (details: { isMainFrame: boolean }) => { if (details.isMainFrame === true) cancel(); };
    event.sender.once('destroyed', cancel);
    event.sender.on('did-start-navigation', navigate);
    try {
      await beforePolish?.();
      if (event.sender.isDestroyed()) controller.abort();
      return { ok: true as const, value: await assistant.polish(input, controller.signal) };
    } catch { return mailFailure('editing-failed'); }
    finally {
      event.sender.removeListener('destroyed', cancel);
      event.sender.removeListener('did-start-navigation', navigate);
    }
  });
  ipcMain.handle('cheshi:mail-mailboxes', event => { assertSender(event); return service.mailboxes(); });
  ipcMain.handle('cheshi:mail-list', (event, mailbox, offset) => { assertSender(event); return service.list(mailbox, offset); });
  ipcMain.handle('cheshi:mail-read', (event, target) => { assertSender(event); return service.read(target); });
  ipcMain.handle('cheshi:mail-conversation', (event, target) => { assertSender(event); return service.conversation(target); });
  ipcMain.handle('cheshi:mail-accounts', event => { assertSender(event); return service.accounts(); });
  ipcMain.handle('cheshi:mail-change', (event, input) => { assertSender(event); return service.change(input); });
  ipcMain.handle('cheshi:mail-send', (event, input) => { assertSender(event); return service.send(input); });
}
