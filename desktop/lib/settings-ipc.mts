import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { SETTINGS_CHANNELS } from '../shared/settings.ts';
import type { createSettingsService } from './settings-service.mts';

export function registerSettingsIpc(options: {
  window: BrowserWindow; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>; service: ReturnType<typeof createSettingsService>;
}) {
  const owner = options.window.webContents;
  const channels: string[] = [];
  let disposed = false, checking = false;
  const assertOwner = (event: IpcMainInvokeEvent) => {
    if (disposed || owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) {
      throw new Error('Settings are only available to their workspace window.');
    }
  };
  const unsubscribe = options.service.subscribe(state => {
    if (!disposed && !owner.isDestroyed()) owner.send(SETTINGS_CHANNELS.changed, state);
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true; unsubscribe();
    options.window.off('closed', dispose);
    for (const channel of channels) options.ipc.removeHandler(channel);
  };
  const handle = (channel: string, listener: Parameters<IpcMain['handle']>[1]) => {
    options.ipc.handle(channel, (event, ...values) => { assertOwner(event); return listener(event, ...values); });
    channels.push(channel);
  };
  try {
    handle(SETTINGS_CHANNELS.get, () => options.service.snapshot());
    handle(SETTINGS_CHANNELS.save, (_event, key: unknown) => options.service.save(key));
    handle(SETTINGS_CHANNELS.remove, () => options.service.remove());
    handle(SETTINGS_CHANNELS.setMenuVisible, (_event, visible: unknown) => options.service.setAutopilotMenuVisible(visible));
    handle(SETTINGS_CHANNELS.check, async () => {
      if (checking) throw new Error('A connection check is already running.');
      checking = true;
      try { return await options.service.check(); }
      finally { checking = false; }
    });
    options.window.on('closed', dispose);
  } catch (error) { dispose(); throw error; }
  return { dispose };
}
