import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { KEEP_AWAKE_CHANNEL, parseKeepAwakeState, type KeepAwakeApi } from '../shared/keep-awake.ts';

export function createKeepAwakeApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): KeepAwakeApi {
  return {
    get: async () => parseKeepAwakeState(await ipc.invoke(`${KEEP_AWAKE_CHANNEL}:get`)),
    async set(enabled) {
      if (enabled !== true && enabled !== false) throw new TypeError('Keep awake requires a boolean.');
      return parseKeepAwakeState(await ipc.invoke(`${KEEP_AWAKE_CHANNEL}:set`, enabled));
    },
    subscribe(listener) {
      const channel = `${KEEP_AWAKE_CHANNEL}:changed`;
      const handler = (_event: IpcRendererEvent, value: unknown) => listener(parseKeepAwakeState(value));
      ipc.on(channel, handler);
      return () => { ipc.removeListener(channel, handler); };
    },
  };
}
