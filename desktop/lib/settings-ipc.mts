import { onWindowClosed } from './window-close-cleanup.mts';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { SETTINGS_CHANNELS, parseFlashEnabled, type FlashReadiness } from '../shared/settings.ts';
import type { createSettingsService } from './settings-service.mts';
import type { FlashActivation } from './flash/activation.mts';

export function registerSettingsIpc(options: {
  window: BrowserWindow; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>; service: ReturnType<typeof createSettingsService>;
  flash?: Pick<FlashActivation, 'getFlashEnabled' | 'setFlashEnabled' | 'subscribeFlashEnabled' | 'readiness'>;
  installation?: { status(): Promise<FlashReadiness>; install(): Promise<FlashReadiness>; isInstalling(): boolean };
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
  const unsubscribeFlash = (options.flash ?? options.service).subscribeFlashEnabled(enabled => {
    if (!disposed && !owner.isDestroyed()) owner.send(SETTINGS_CHANNELS.flashEnabledChanged, enabled);
  });
  let unsubscribeClosed = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true; unsubscribeProjectDoc(); unsubscribeFlash();
    unsubscribeClosed();
    for (const channel of channels) options.ipc.removeHandler(channel);
  };
  const handle = (channel: string, listener: Parameters<IpcMain['handle']>[1]) => {
    options.ipc.handle(channel, (event, ...values) => { assertOwner(event); return listener(event, ...values); });
    channels.push(channel);
  };
  try {
    handle(SETTINGS_CHANNELS.getFlashEnabled, () => options.flash?.getFlashEnabled() ?? false);
    handle(SETTINGS_CHANNELS.getFlashReadiness, () => options.installation?.status()
      ?? options.flash?.readiness() ?? { ready: false, detail: 'Flash installation is unavailable.' });
    handle(SETTINGS_CHANNELS.installFlash, () => {
      if (!options.installation) throw new Error('Flash installation is unavailable.');
      return options.installation.install();
    });
    handle(SETTINGS_CHANNELS.setFlashEnabled, (_event, value: unknown) => {
      const enabled = parseFlashEnabled(value);
      if (enabled && options.installation?.isInstalling()) throw new Error('Wait for Flash installation to finish.');
      if (options.flash) return options.flash.setFlashEnabled(enabled);
      if (enabled) throw new Error('Flash readiness verification is unavailable.');
      return options.service.setFlashEnabled(false);
    });
    handle(SETTINGS_CHANNELS.getProjectDocMaxBytes, () => options.service.getProjectDocMaxBytes());
    handle(SETTINGS_CHANNELS.setProjectDocMaxBytes, (_event, bytes: unknown) => options.service.setProjectDocMaxBytes(bytes));
    unsubscribeClosed = onWindowClosed(options.window, dispose);
  } catch (error) { dispose(); throw error; }
  return { dispose };
}
