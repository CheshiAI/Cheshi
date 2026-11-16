import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { AppleCalendarService } from './apple-calendar-service.mts';

export function registerAppleCalendarIpc({ ipcMain, service, assertSender }: {
  ipcMain: Pick<IpcMain, 'handle'>;
  service: AppleCalendarService;
  assertSender: (event: IpcMainInvokeEvent) => void;
}): void {
  ipcMain.handle('cheshi:calendar-status', event => { assertSender(event); return service.status(); });
  ipcMain.handle('cheshi:calendar-connect', event => { assertSender(event); return service.connect(); });
  ipcMain.handle('cheshi:calendar-calendars', event => { assertSender(event); return service.calendars(); });
  ipcMain.handle('cheshi:calendar-events', (event, query) => { assertSender(event); return service.events(query); });
  ipcMain.handle('cheshi:calendar-create', (event, input) => { assertSender(event); return service.create(input); });
  ipcMain.handle('cheshi:calendar-update', (event, input) => { assertSender(event); return service.update(input); });
  ipcMain.handle('cheshi:calendar-delete', (event, target) => { assertSender(event); return service.delete(target); });
}
