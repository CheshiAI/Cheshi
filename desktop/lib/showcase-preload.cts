import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { SHOWCASE_CHANNELS, parseShowcaseAction, parseShowcaseState, parseShowcaseViewRequest } from '../shared/showcase.ts';
import type { ShowcaseApi } from '../shared/showcase.ts';

export function createShowcaseApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): ShowcaseApi {
  return {
    async setView(request) { await ipc.invoke(SHOWCASE_CHANNELS.view, parseShowcaseViewRequest(request)); },
    async navigate(action) { await ipc.invoke(SHOWCASE_CHANNELS.navigate, parseShowcaseAction(action)); },
    onState(handler) {
      const listener = (_event: IpcRendererEvent, value: unknown) => handler(parseShowcaseState(value));
      ipc.on(SHOWCASE_CHANNELS.state, listener);
      return () => { ipc.removeListener(SHOWCASE_CHANNELS.state, listener); };
    },
  };
}
