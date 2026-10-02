import { onWindowClosed } from './window-close-cleanup.mts';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { IMESSAGE_CHANNEL } from '../shared/imessage-notifications.ts';
import type { createIMessageNotifications } from './imessage-notifications.mts';

export function registerIMessageIpc(options: {
  window: BrowserWindow; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  service: ReturnType<typeof createIMessageNotifications>;
  commands?: ReturnType<typeof import('./imessage-commands.mts').createIMessageCommands>;
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
  let unsubscribeClosed = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true; unsubscribe(); unsubscribeClosed();
    for (const channel of channels) options.ipc.removeHandler(channel);
  };
  try {
    handle('get', () => options.service.get());
    handle('save', value => options.service.save(value));
    handle('test', () => options.service.test());
    if (options.commands) {
      handle('commands:get', () => options.commands!.get());
      handle('commands:configure', value => options.commands!.configure(value));
    }
    unsubscribeClosed = onWindowClosed(options.window, dispose);
  } catch (error) { dispose(); throw error; }
  return { dispose };
}
