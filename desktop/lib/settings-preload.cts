import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { SETTINGS_CHANNELS, parseHomiesEnabled, parseFlashEnabled, parseFlashReadiness, parseFlashInstallSource, parseProjectDocMaxBytes } from '../shared/settings.ts';
import type { SettingsApi } from '../shared/settings.ts';
import { parseHomieSetupStatus } from '../shared/homie-setup.ts';

export function createSettingsApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): SettingsApi {
  return {
    async getHomiesEnabled() { return parseHomiesEnabled(await ipc.invoke(SETTINGS_CHANNELS.getHomiesEnabled)); },
    async setHomiesEnabled(value) { return parseHomiesEnabled(await ipc.invoke(SETTINGS_CHANNELS.setHomiesEnabled, parseHomiesEnabled(value))); },
    onHomiesEnabledChanged(handler) {
      const listener = (_event: IpcRendererEvent, value: unknown) => handler(parseHomiesEnabled(value));
      ipc.on(SETTINGS_CHANNELS.homiesEnabledChanged, listener);
      return () => { ipc.removeListener(SETTINGS_CHANNELS.homiesEnabledChanged, listener); };
    },
    async getHomieSetup() { return parseHomieSetupStatus(await ipc.invoke(SETTINGS_CHANNELS.getHomieSetup)); },
    async installHomieTools() { return parseHomieSetupStatus(await ipc.invoke(SETTINGS_CHANNELS.installHomieTools)); },
    async startHomieEngine() { return parseHomieSetupStatus(await ipc.invoke(SETTINGS_CHANNELS.startHomieEngine)); },
    async getFlashReadiness() { return parseFlashReadiness(await ipc.invoke(SETTINGS_CHANNELS.getFlashReadiness)); },
    async installFlash(source) { return parseFlashReadiness(await ipc.invoke(SETTINGS_CHANNELS.installFlash, parseFlashInstallSource(source))); },
    async checkFlashUpdates(source) { return parseFlashReadiness(await ipc.invoke(SETTINGS_CHANNELS.checkFlashUpdates, parseFlashInstallSource(source))); },
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
