import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { NOTIFICATION_EVENTS_CHANNEL } from '../shared/notification-events.ts';
import type { createNotificationEvents } from './notification-events.mts';

export function registerNotificationEventsIpc(options: {
  window: BrowserWindow; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  service: ReturnType<typeof createNotificationEvents>;
}) {
  const owner = options.window.webContents;
  const channels: string[] = [];
  const assertOwner = (event: IpcMainInvokeEvent) => {
    if (owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error('Invalid notification settings owner.');
  };
  const unsubscribe = options.service.subscribe(value => {
    if (!owner.isDestroyed()) owner.send(`${NOTIFICATION_EVENTS_CHANNEL}:changed`, value);
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; unsubscribe(); options.window.off('closed', dispose);
    for (const channel of channels) options.ipc.removeHandler(channel);
  };
  try {
    for (const action of ['get', 'set'] as const) {
      const channel = `${NOTIFICATION_EVENTS_CHANNEL}:${action}`;
      options.ipc.handle(channel, (event, kind, enabled) => {
        assertOwner(event);
        return action === 'get' ? options.service.get() : options.service.set(kind, enabled);
      });
      channels.push(channel);
    }
    options.window.once('closed', dispose);
  } catch (error) { dispose(); throw error; }
  return { dispose };
}
