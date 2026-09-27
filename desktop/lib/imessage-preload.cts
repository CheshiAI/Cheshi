import type { IpcRenderer } from 'electron';
import { IMESSAGE_CHANNEL, parseIMessagePreferences, parseIMessageSettings, type IMessageApi } from '../shared/imessage-notifications.ts';
export function createIMessageApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): IMessageApi {
  const read = async (suffix: string, value?: unknown) => parseIMessageSettings(await ipc.invoke(`${IMESSAGE_CHANNEL}:${suffix}`, value));
  return {
    get: () => read('get'), save: value => read('save', parseIMessagePreferences(value)), test: () => read('test'),
    reportQueue: (contextId, threads) => ipc.invoke(`${IMESSAGE_CHANNEL}:queue`, { contextId, threads }),
    onChanged: listener => {
      const handler = (_event: unknown, value: unknown) => { listener(parseIMessageSettings(value)); };
      ipc.on(`${IMESSAGE_CHANNEL}:changed`, handler);
      return () => { ipc.removeListener(`${IMESSAGE_CHANNEL}:changed`, handler); };
    },
  };
}
