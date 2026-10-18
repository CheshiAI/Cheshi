import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { SETTINGS_CHANNELS, parseFlashEnabled, parseFlashReadiness, parseProjectDocMaxBytes } from '../shared/settings.ts';
import type { SettingsApi } from '../shared/settings.ts';

export function createSettingsApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): SettingsApi {
  return {
    async getFlashReadiness() { return parseFlashReadiness(await ipc.invoke(SETTINGS_CHANNELS.getFlashReadiness)); },
    async installFlash() { return parseFlashReadiness(await ipc.invoke(SETTINGS_CHANNELS.installFlash)); },
    async checkFlashUpdates() { return parseFlashReadiness(await ipc.invoke(SETTINGS_CHANNELS.checkFlashUpdates)); },
    async uninstallFlash() { return parseFlashReadiness(await ipc.invoke(SETTINGS_CHANNELS.uninstallFlash)); },
    async getFlashEnabled() { return parseFlashEnabled(await ipc.invoke(SETTINGS_CHANNELS.getFlashEnabled)); },
    async setFlashEnabled(enabled) {
      return parseFlashEnabled(await ipc.invoke(SETTINGS_CHANNELS.setFlashEnabled, parseFlashEnabled(enabled)));
    },
    onFlashEnabledChanged(handler) {
      const listener = (_event: IpcRendererEvent, value: unknown) => handler(parseFlashEnabled(value));
      ipc.on(SETTINGS_CHANNELS.flashEnabledChanged, listener);
      return () => { ipc.removeListener(SETTINGS_CHANNELS.flashEnabledChanged, listener); };
    },
    async getProjectDocMaxBytes() { return parseProjectDocMaxBytes(await ipc.invoke(SETTINGS_CHANNELS.getProjectDocMaxBytes)); },
    async setProjectDocMaxBytes(bytes) {
      return parseProjectDocMaxBytes(await ipc.invoke(SETTINGS_CHANNELS.setProjectDocMaxBytes, parseProjectDocMaxBytes(bytes)));
    },
    onProjectDocMaxBytesChanged(handler) {
      const listener = (_event: IpcRendererEvent, value: unknown) => handler(parseProjectDocMaxBytes(value));
      ipc.on(SETTINGS_CHANNELS.projectDocMaxBytesChanged, listener);
      return () => { ipc.removeListener(SETTINGS_CHANNELS.projectDocMaxBytesChanged, listener); };
    },
  };
}
