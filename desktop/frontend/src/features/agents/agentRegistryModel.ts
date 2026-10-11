import type { AgentRegistryApi, AgentRegistrySnapshot, SaveSpecialistAgent, DeleteSpecialistAgent, SpecialistAgent } from '../../../../shared/agent-registry';
import type { AgentRuntimeRequest, AgentRuntimeState } from '../../../../shared/agent-runtime';
import { HomieCatalog } from './homieCatalog';

function workerStartError(result: AgentRuntimeState): string | null {
  return result.unavailable?.message ?? result.lifecycle?.error ?? result.details?.error
    ?? (result.details?.ready === true ? null : 'Worker is not ready. Check its status and retry.');
}

export interface AgentRegistryState {
  data: AgentRegistrySnapshot | null; loading: boolean; saving: boolean; error: string | null; selection: string | null;
  starting?: boolean;
}
export class AgentRegistryModel {
  readonly catalog: HomieCatalog;
  private readonly api: AgentRegistryApi;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<() => void>();
  private state: AgentRegistryState = { data: null, loading: false, saving: false, error: null, selection: null };
  private active = true;
  private request = 0;
  private publication = 0;
  constructor(api: AgentRegistryApi) {
    this.api = api;
    this.catalog = new HomieCatalog(id => api.models(id));
    this.unsubscribe = api.onDidChange(data => {
      this.request++; this.publication++;
      this.publish({ data, loading: false, error: null });
    });
  }
  snapshot = () => this.state;
  source = (input: import('../../../../shared/homie-source').HomieSourceRequest) => {
    if (!this.api.source) return Promise.reject(new Error('Restart Cheshi to use repository configuration.'));
    return this.api.source(input);
  };
  runtime = async (request: AgentRuntimeRequest) => {
    if (!this.api.runtime) throw new Error('Agent runtime is unavailable. Restart Cheshi.');
    const result = await this.api.runtime(request);
    if (request.action === 'start' && request.agentId === this.state.selection && workerStartError(result) === null) {
      this.publish({ error: null });
    }
    return result;
  };
  toolCredential = (input: import('../../../../shared/homie-tools').ToolCredentialRequest) => this.api.toolCredential?.(input) ?? Promise.reject(new Error('Restart Cheshi to configure tool credentials.'));
  testTool = (input: import('../../../../shared/homie-tools').ToolTestRequest) => this.api.testTool?.(input) ?? Promise.reject(new Error('Restart Cheshi to test tools.'));
  installPackage = (definition: import('../../../../shared/agent-package').AgentPackage, instructionFiles: string[] = []) => {
    if (!this.api.installPackage) return Promise.reject(new Error('Pack installation is unavailable. Restart Cheshi.'));
    return this.api.installPackage(definition, instructionFiles);
  };
  exportPackage = (definition: import('../../../../shared/agent-package').AgentPackage, instructionFiles: string[] = []) => {
    if (!this.api.exportPackage) return Promise.reject(new Error('Pack export is unavailable. Restart Cheshi.'));
    return this.api.exportPackage(definition, instructionFiles);
  };
  packages = () => this.api.packages?.() ?? Promise.resolve([]);
  importPackage = () => {
    if (!this.api.importPackage) return Promise.reject(new Error('Package import is unavailable. Restart Cheshi.'));
    return this.api.importPackage();
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
  private async startCreatedAgent(agent: SpecialistAgent, workspaceRoot: string, engineId?: string | null): Promise<string | null> {
    if (!agent.accountId) return 'Choose an account in Agent settings, then use Start agent.';
    if (!agent.assignments.some(assignment => assignment.workspaceRoot === workspaceRoot)) {
      return 'Assign this Homie to the current project, then use Start agent.';
    }
    if (!engineId?.startsWith('docker:')) return 'Choose a Docker execution engine, then use Start agent.';
    this.publish({ starting: true });
    try {
      return workerStartError(await this.runtime({ agentId: agent.id, engineId, action: 'start' }));
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not start the worker.';
    }
  }
  async save(input: SaveSpecialistAgent, engineId?: string | null) {
    if (!this.active || this.state.saving) throw new Error('An agent save is already in progress.');
    this.publish({ saving: true, starting: false, error: null });
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
      this.publish({ data: { ...result.snapshot, agents: [...agents.values()] }, loading: false });
      const repositoryError = result.repositoryError;
      const startError = !repositoryError && input.id === null && this.active
        ? await this.startCreatedAgent(agents.get(result.agentId)!, result.snapshot.workspaceRoot, engineId) : null;
      this.publish({ selection: result.agentId, saving: false, starting: false,
        error: repositoryError ? `Homie saved, but its GitHub repository is not ready. ${repositoryError} Use Start agent to retry.`
          : startError ? `Homie saved, but its worker did not start. ${startError}` : null });
      return result.snapshot.agents.find(agent => agent.id === result.agentId)!;
    } catch (error) {
      this.publish({ saving: false, starting: false, error: error instanceof Error ? error.message : 'Could not save agent.' });
      throw error;
    }
  }
  dispose() { this.active = false; this.request++; this.unsubscribe(); this.listeners.clear(); this.catalog.dispose(); }
}
