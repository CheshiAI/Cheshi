import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { CODEX_UPDATE_CHANNEL, type CodexUpdateApi, type CodexUpdateState } from '../shared/codex-update.ts';

export function createCodexUpdateApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): CodexUpdateApi {
  return {
    getCodexUpdate: () => ipc.invoke(`${CODEX_UPDATE_CHANNEL}:get`),
    checkCodexUpdate: () => ipc.invoke(`${CODEX_UPDATE_CHANNEL}:check`),
    installCodexUpdate: () => ipc.invoke(`${CODEX_UPDATE_CHANNEL}:install`),
    syncWorkerCodex: () => ipc.invoke(`${CODEX_UPDATE_CHANNEL}:workers`),
    onCodexUpdateChanged(listener) {
      const handler = (_event: IpcRendererEvent, state: CodexUpdateState) => listener(state);
      ipc.on(`${CODEX_UPDATE_CHANNEL}:changed`, handler);
      return () => { ipc.removeListener(`${CODEX_UPDATE_CHANNEL}:changed`, handler); };
    },
  };
}
