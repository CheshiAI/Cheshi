import { onWindowClosed } from './window-close-cleanup.mts';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { SETTINGS_CHANNELS } from '../shared/settings.ts';
import type { createSettingsService } from './settings-service.mts';

export function registerSettingsIpc(options: {
  window: BrowserWindow; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>; service: ReturnType<typeof createSettingsService>;
}) {
  const owner = options.window.webContents;
  const channels: string[] = [];
  let disposed = false;
  const assertOwner = (event: IpcMainInvokeEvent) => {
    if (disposed || owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) {
      throw new Error('Settings are only available to their workspace window.');
    }
  };
  const unsubscribeProjectDoc = options.service.subscribeProjectDocMaxBytes(bytes => {
    if (!disposed && !owner.isDestroyed()) owner.send(SETTINGS_CHANNELS.projectDocMaxBytesChanged, bytes);
  });
  let unsubscribeClosed = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true; unsubscribeProjectDoc();
    unsubscribeClosed();
    for (const channel of channels) options.ipc.removeHandler(channel);
  };
  const handle = (channel: string, listener: Parameters<IpcMain['handle']>[1]) => {
    options.ipc.handle(channel, (event, ...values) => { assertOwner(event); return listener(event, ...values); });
    channels.push(channel);
  };
  try {
    handle(SETTINGS_CHANNELS.getProjectDocMaxBytes, () => options.service.getProjectDocMaxBytes());
    handle(SETTINGS_CHANNELS.setProjectDocMaxBytes, (_event, bytes: unknown) => options.service.setProjectDocMaxBytes(bytes));
    unsubscribeClosed = onWindowClosed(options.window, dispose);
  } catch (error) { dispose(); throw error; }
  return { dispose };
}
