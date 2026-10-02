import type { IpcRenderer } from 'electron';
import { AGENT_CHANNELS, parseAgentAction, parseAgentCatalog, parseAgentDetails, parseAgentEngineId,
  parseAgentId, parseAgentSnapshot } from '../shared/agent-management.ts';
import type { AgentManagementApi } from '../shared/agent-management.ts';

export function createAgentManagementApi(ipc: Pick<IpcRenderer, 'invoke'>): AgentManagementApi {
  return {
    async engines() { return parseAgentCatalog(await ipc.invoke(AGENT_CHANNELS.engines)); },
    async snapshot(engine) { return parseAgentSnapshot(await ipc.invoke(AGENT_CHANNELS.snapshot, parseAgentEngineId(engine))); },
    async details(engine, id) { return parseAgentDetails(await ipc.invoke(AGENT_CHANNELS.details, parseAgentEngineId(engine), parseAgentId(id))); },
    async control(engine, id, action) {
      return parseAgentSnapshot(await ipc.invoke(AGENT_CHANNELS.control, parseAgentEngineId(engine), parseAgentId(id), parseAgentAction(action)));
    },
  };
}
