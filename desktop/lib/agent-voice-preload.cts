import type { IpcRenderer } from 'electron';
import { VOICE_CHANNEL, parseVoiceRequest, parseVoiceSnapshot, type AgentVoiceApi } from '../shared/agent-voice.ts';
export function createAgentVoiceApi(ipc: Pick<IpcRenderer, 'invoke'>): AgentVoiceApi {
  return { request: async input => parseVoiceSnapshot(await ipc.invoke(VOICE_CHANNEL, parseVoiceRequest(input))) };
}
