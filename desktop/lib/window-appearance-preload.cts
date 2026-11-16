import type { IpcRenderer } from 'electron';
import { APPEARANCE_CHANNELS, parseWindowAppearance, parseWindowAppearanceState } from '../shared/window-appearance.ts';
import type { WindowAppearanceApi } from '../shared/window-appearance.ts';

export function createWindowAppearanceApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): WindowAppearanceApi {
  return {
    get: async () => parseWindowAppearanceState(await ipc.invoke(APPEARANCE_CHANNELS.get)),
    set: async value => parseWindowAppearanceState(await ipc.invoke(APPEARANCE_CHANNELS.set, parseWindowAppearance(value))),
    onChanged(handler) {
      const listener: Parameters<IpcRenderer['on']>[1] = (_event, value: unknown) => handler(parseWindowAppearanceState(value));
      ipc.on(APPEARANCE_CHANNELS.changed, listener);
      return () => { ipc.removeListener(APPEARANCE_CHANNELS.changed, listener); };
    },
  };
}
