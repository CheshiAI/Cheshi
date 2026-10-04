import type { IpcRenderer } from 'electron';
import { AGENT_CHATS_CHANNEL, AGENT_CHATS_CHANGED, parseChatsRequest, parseChatsSnapshot, parseChatsUpdate, type AgentChatsApi } from '../shared/agent-chats.ts';
export function createAgentChatsApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): AgentChatsApi {
  return {
    request: async input => parseChatsSnapshot(await ipc.invoke(AGENT_CHATS_CHANNEL, parseChatsRequest(input))),
    onDidChange(listener) {
      const receive = (_event: unknown, value: unknown) => listener(parseChatsUpdate(value));
      ipc.on(AGENT_CHATS_CHANGED, receive);
      return () => { ipc.removeListener(AGENT_CHATS_CHANGED, receive); };
    },
  };
}
