import { AGENT_RUNTIME_CHANNEL, parseAgentRuntimeRequest, parseAgentRuntimeState } from '../shared/agent-runtime.ts';
import type { IpcRenderer } from 'electron';
import { AGENT_REGISTRY_CHANNELS, parseAgentRegistrySnapshot, parseAgentRegistrySaveResult, parseSaveSpecialistAgent, parseDeleteSpecialistAgent } from '../shared/agent-registry.ts';
import type { AgentRegistryApi } from '../shared/agent-registry.ts';
import { parseAgentModels } from '../shared/agent-models.ts';
import { isCodexAccountId } from '../shared/codex-accounts.ts';

export function createAgentRegistryApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): AgentRegistryApi {
  return {
    async remove(input) { return parseAgentRegistrySnapshot(await ipc.invoke(AGENT_REGISTRY_CHANNELS.remove, parseDeleteSpecialistAgent(input))); },
    async runtime(input) { return parseAgentRuntimeState(await ipc.invoke(AGENT_RUNTIME_CHANNEL, parseAgentRuntimeRequest(input))); },
    async models(accountId) {
      if (!isCodexAccountId(accountId)) throw new TypeError('Invalid agent account.');
      return parseAgentModels(await ipc.invoke(AGENT_REGISTRY_CHANNELS.models, accountId));
    },
    async list() { return parseAgentRegistrySnapshot(await ipc.invoke(AGENT_REGISTRY_CHANNELS.list)); },
    async save(input) { return parseAgentRegistrySaveResult(await ipc.invoke(AGENT_REGISTRY_CHANNELS.save, parseSaveSpecialistAgent(input))); },
    onDidChange(listener) {
      const receive = (_event: unknown, value: unknown) => listener(parseAgentRegistrySnapshot(value));
      ipc.on(AGENT_REGISTRY_CHANNELS.changed, receive);
      return () => { ipc.removeListener(AGENT_REGISTRY_CHANNELS.changed, receive); };
    },
  };
}
