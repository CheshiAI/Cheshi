import type { IpcRenderer } from 'electron';
import { AGENT_REGISTRY_CHANNELS, parseAgentRegistrySnapshot, parseAgentRegistrySaveResult, parseSaveSpecialistAgent } from '../shared/agent-registry.ts';
import type { AgentRegistryApi } from '../shared/agent-registry.ts';

export function createAgentRegistryApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): AgentRegistryApi {
  return {
    async list() { return parseAgentRegistrySnapshot(await ipc.invoke(AGENT_REGISTRY_CHANNELS.list)); },
    async save(input) { return parseAgentRegistrySaveResult(await ipc.invoke(AGENT_REGISTRY_CHANNELS.save, parseSaveSpecialistAgent(input))); },
    onDidChange(listener) {
      const receive = (_event: unknown, value: unknown) => listener(parseAgentRegistrySnapshot(value));
      ipc.on(AGENT_REGISTRY_CHANNELS.changed, receive);
      return () => { ipc.removeListener(AGENT_REGISTRY_CHANNELS.changed, receive); };
    },
  };
}
