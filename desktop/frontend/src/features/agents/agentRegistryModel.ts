import type { AgentRegistryApi, AgentRegistrySnapshot, SaveSpecialistAgent, DeleteSpecialistAgent } from '../../../../shared/agent-registry';

export interface AgentRegistryState {
  data: AgentRegistrySnapshot | null; loading: boolean; saving: boolean; error: string | null; selection: string | null;
}
export class AgentRegistryModel {
  private readonly api: AgentRegistryApi;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<() => void>();
  private state: AgentRegistryState = { data: null, loading: false, saving: false, error: null, selection: null };
  private active = true;
  private request = 0;
  private publication = 0;
  constructor(api: AgentRegistryApi) {
    this.api = api;
    this.unsubscribe = api.onDidChange(data => {
      this.request++; this.publication++;
      this.publish({ data, loading: false, error: null });
    });
  }
  snapshot = () => this.state;
  runtime = (request: import('../../../../shared/agent-runtime').AgentRuntimeRequest) => {
    if (!this.api.runtime) return Promise.reject(new Error('Agent runtime is unavailable. Restart Cheshi.'));
    return this.api.runtime(request);
  };
  models = (accountId: string) => this.api.models(accountId);
  packages = () => this.api.packages?.() ?? Promise.resolve([]);
  importPackage = () => {
    if (!this.api.importPackage) return Promise.reject(new Error('Package import is unavailable. Restart Cheshi.'));
    return this.api.importPackage();
  };
  selectInstructionFiles = () => {
    if (!this.api.selectInstructionFiles) return Promise.reject(new Error('Instruction file selection is unavailable. Restart Cheshi.'));
    return this.api.selectInstructionFiles();
  };
  openInstructionFile = (path: string) => {
    if (!this.api.openInstructionFile) return Promise.reject(new Error('Opening instruction files is unavailable. Restart Cheshi.'));
    return this.api.openInstructionFile(path);
  };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<AgentRegistryState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  select(selection: string | null) { if (!this.state.saving) this.publish({ selection, error: null }); }
  async remove(input: DeleteSpecialistAgent) {
    if (!this.active || this.state.saving) throw new Error('An agent operation is already in progress.');
    if (!this.api.remove) throw new Error('Agent deletion is unavailable. Restart Cheshi.');
    this.request++;
    this.publish({ saving: true, error: null });
    const publication = this.publication;
    try {
      const result = await this.api.remove(input);
      const data = publication !== this.publication && this.state.data ? this.state.data : result;
      this.request++;
      this.publish({ data: { ...data, agents: data.agents.filter(agent => agent.id !== input.id) },
        saving: false, loading: false, selection: this.state.selection === input.id ? null : this.state.selection });
    } catch (error) {
      this.publish({ saving: false, error: error instanceof Error ? error.message : 'Could not delete agent.' });
      throw error;
    }
  }
  async refresh() {
    const request = ++this.request;
    this.publish({ loading: true, error: null });
    try {
      const data = await this.api.list();
      if (request === this.request) { this.publication++; this.publish({ data, loading: false }); }
    } catch (error) {
      if (request === this.request) this.publish({ loading: false, error: error instanceof Error ? error.message : 'Could not read agents.' });
    }
  }
  async save(input: SaveSpecialistAgent) {
    if (!this.active || this.state.saving) throw new Error('An agent save is already in progress.');
    this.publish({ saving: true, error: null });
    const publication = this.publication;
    try {
      const result = await this.api.save(input);
      // Preserve newer edits from notifications, while including this acknowledged save.
      const current = this.state.data;
      const agents = new Map(result.snapshot.agents.map(agent => [agent.id, agent]));
      if (publication !== this.publication && current) {
        for (const agent of current.agents) {
          if ((agents.get(agent.id)?.revision ?? 0) < agent.revision) agents.set(agent.id, agent);
        }
      }
      this.request++;
      this.publish({ data: { ...result.snapshot, agents: [...agents.values()] },
        selection: result.agentId, saving: false, loading: false });
      return result.snapshot.agents.find(agent => agent.id === result.agentId)!;
    } catch (error) {
      this.publish({ saving: false, error: error instanceof Error ? error.message : 'Could not save agent.' });
      throw error;
    }
  }
  dispose() { this.active = false; this.request++; this.unsubscribe(); this.listeners.clear(); }
}
