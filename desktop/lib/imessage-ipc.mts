import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { IMESSAGE_CHANNEL } from '../shared/imessage-notifications.ts';
import type { createIMessageNotifications } from './imessage-notifications.mts';

export function registerIMessageIpc(options: {
  window: BrowserWindow; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  service: ReturnType<typeof createIMessageNotifications>;
}) {
  const owner = options.window.webContents;
  const assertOwner = (event: IpcMainInvokeEvent) => {
    if (owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error('Invalid notification settings owner.');
  };
  const channels: string[] = [];
  const handle = (suffix: string, action: (value: unknown) => unknown) => {
    const channel = `${IMESSAGE_CHANNEL}:${suffix}`;
    options.ipc.handle(channel, (event, value) => { assertOwner(event); return action(value); }); channels.push(channel);
  };
  const unsubscribe = options.service.subscribe(state => {
    if (!owner.isDestroyed()) owner.send(`${IMESSAGE_CHANNEL}:changed`, state);
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; unsubscribe(); options.window.off('closed', dispose);
    for (const channel of channels) options.ipc.removeHandler(channel);
  };
  try {
    handle('get', () => options.service.get());
    handle('save', value => options.service.save(value));
    handle('test', () => options.service.test());
    options.window.once('closed', dispose);
  } catch (error) { dispose(); throw error; }
  return { dispose };
}
