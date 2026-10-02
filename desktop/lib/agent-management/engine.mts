import type { AgentAction, AgentEngineInfo, ManagedAgent } from '../../shared/agent-management.ts';

export interface RuntimeAgent extends ManagedAgent { endpoint: string | null }
/** Provider lifecycle (starting a VM, installation, image builds) stays outside this boundary. */
export interface AgentEngine {
  kind: string;
  engines(): Promise<AgentEngineInfo[]>;
  list(engineId: string): Promise<ManagedAgent[]>;
  inspect(engineId: string, agentId: string): Promise<RuntimeAgent>;
  control(engineId: string, agentId: string, action: AgentAction): Promise<void>;
  logs(engineId: string, agentId: string): Promise<string>;
  terminalCommand?(engineId: string, agentId: string): Promise<string>;
}
