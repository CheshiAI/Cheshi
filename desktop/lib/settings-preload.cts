import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { SETTINGS_CHANNELS, parseAutopilotMenuVisible, parseTypeSafeKey, parseTypeSafeSettings } from '../shared/settings.ts';
import type { SettingsApi } from '../shared/settings.ts';

export function createSettingsApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): SettingsApi {
  return {
    async getTypeSafe() { return parseTypeSafeSettings(await ipc.invoke(SETTINGS_CHANNELS.get)); },
    async saveTypeSafe(key) { return parseTypeSafeSettings(await ipc.invoke(SETTINGS_CHANNELS.save, parseTypeSafeKey(key))); },
    async removeTypeSafe() { return parseTypeSafeSettings(await ipc.invoke(SETTINGS_CHANNELS.remove)); },
    async setAutopilotMenuVisible(visible) {
      return parseTypeSafeSettings(await ipc.invoke(SETTINGS_CHANNELS.setMenuVisible, parseAutopilotMenuVisible(visible)));
    },
    async checkTypeSafe() {
      const result: unknown = await ipc.invoke(SETTINGS_CHANNELS.check);
      if (result !== true && result !== false) throw new TypeError('Invalid connection check result.');
      return result;
    },
    onTypeSafeChanged(handler) {
      const listener = (_event: IpcRendererEvent, value: unknown) => handler(parseTypeSafeSettings(value));
      ipc.on(SETTINGS_CHANNELS.changed, listener);
      return () => { ipc.removeListener(SETTINGS_CHANNELS.changed, listener); };
    },
  };
}
