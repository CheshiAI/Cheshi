import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { SETTINGS_CHANNELS, parseProjectDocMaxBytes } from '../shared/settings.ts';
import type { SettingsApi } from '../shared/settings.ts';

export function createSettingsApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): SettingsApi {
  return {
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
