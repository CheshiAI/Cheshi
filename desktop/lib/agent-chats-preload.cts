import type { IpcRenderer } from 'electron';
import { AGENT_CHATS_CHANNEL, parseChatsRequest, parseChatsSnapshot, type AgentChatsApi } from '../shared/agent-chats.ts';
export function createAgentChatsApi(ipc: Pick<IpcRenderer, 'invoke'>): AgentChatsApi {
  return { request: async input => parseChatsSnapshot(await ipc.invoke(AGENT_CHATS_CHANNEL, parseChatsRequest(input))) };
}
