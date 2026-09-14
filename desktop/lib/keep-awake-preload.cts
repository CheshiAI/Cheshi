import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { KEEP_AWAKE_CHANNEL, type KeepAwakeApi, type KeepAwakeState } from '../shared/keep-awake.ts';

export function createKeepAwakeApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): KeepAwakeApi {
  return {
    getKeepAwake: () => ipc.invoke(`${KEEP_AWAKE_CHANNEL}:get`),
    setKeepAwake: enabled => ipc.invoke(`${KEEP_AWAKE_CHANNEL}:set`, enabled),
    onKeepAwakeChanged(listener) {
      const handler = (_event: IpcRendererEvent, state: KeepAwakeState) => listener(state);
      ipc.on(`${KEEP_AWAKE_CHANNEL}:changed`, handler);
      return () => { ipc.removeListener(`${KEEP_AWAKE_CHANNEL}:changed`, handler); };
    },
  };
}
