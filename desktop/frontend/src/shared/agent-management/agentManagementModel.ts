import type { AgentAction, AgentCatalog, AgentDetails, AgentManagementApi, AgentSnapshot } from '../../../../shared/agent-management';

export interface AgentManagementState {
  catalog: AgentCatalog; engineId: string; agentId: string; snapshot: AgentSnapshot | null;
  details: AgentDetails | null; loading: boolean; changing: boolean; error: string | null;
}
function message(error: unknown) { return error instanceof Error ? error.message : 'Could not inspect workers.'; }

export class AgentManagementModel {
  private state: AgentManagementState = { catalog: { engines: [], error: null }, engineId: '', agentId: '',
    snapshot: null, details: null, loading: false, changing: false, error: null };
  private readonly api: AgentManagementApi;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private active = true;
  private refreshing = false;
  constructor(api: AgentManagementApi) { this.api = api; }
  get terminal() { return this.api.terminal; }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<AgentManagementState>) {
    if (!this.active) return;
    if (Object.entries(patch).every(([key, value]) => {
      const current = this.state[key as keyof AgentManagementState];
      return Object.is(current, value) || (typeof value === 'object' && JSON.stringify(current) === JSON.stringify(value));
    })) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  dispose() { this.active = false; this.revision++; this.listeners.clear(); }
  async discover() {
    if (this.state.changing) return;
    const revision = ++this.revision;
    this.refreshing = false;
    this.publish({ loading: true, error: null });
    try {
      const catalog = await this.api.engines();
      if (!this.active || revision !== this.revision) return;
      const previous = catalog.engines.find(engine => engine.id === this.state.engineId && engine.supported);
      const preferred = catalog.engines.find(engine => engine.id === 'docker:colima-cheshi' && engine.supported);
      const engine = previous ?? preferred ?? catalog.engines.find(item => item.supported);
      this.publish({ catalog, loading: false });
      if (engine?.id === this.state.engineId) await this.refresh();
      else await this.connect(engine?.id ?? '');
    } catch (error) { if (revision === this.revision) this.publish({ loading: false, error: message(error) }); }
  }
  async connect(engineId: string) {
    if (this.state.changing) return;
    this.revision++; this.refreshing = false;
    this.publish({ engineId, agentId: '', snapshot: null, details: null, error: null, loading: false });
    if (engineId) await this.refresh();
  }
  async select(agentId: string) {
    if (this.state.changing) return;
    this.revision++; this.refreshing = false;
    this.publish({ agentId, details: null, error: null });
    await this.refresh();
  }
  async refresh({ background = false } = {}) {
    const { engineId } = this.state;
    if (!engineId || this.refreshing || this.state.changing || !this.active) return;
    this.refreshing = true;
    const revision = ++this.revision;
    if (!background) this.publish({ loading: true });
    try {
      const snapshot = await this.api.snapshot(engineId);
      if (!this.active || revision !== this.revision) return;
      const agent = snapshot.agents.find(item => item.id === this.state.agentId) ?? snapshot.agents[0];
      // Clear an old selection as soon as the engine says it no longer exists.
      this.publish({ snapshot, agentId: agent?.id ?? '',
        details: agent?.id === this.state.details?.agent.id ? this.state.details : null, error: null });
      if (agent?.pendingDeletion) this.publish({ details: null });
      else if (agent) {
        const details = await this.api.details(engineId, agent.id);
        if (revision === this.revision) this.publish({ details });
      }
    } catch (error) { if (revision === this.revision) this.publish({ error: message(error) }); }
    finally { if (revision === this.revision) { this.refreshing = false; if (!background) this.publish({ loading: false }); } }
  }
  async control(action: AgentAction) {
    const { engineId, agentId, error, snapshot } = this.state;
    if (this.state.changing || !agentId || error || !snapshot?.online || !this.active) return;
    const revision = ++this.revision;
    this.refreshing = false;
    this.publish({ changing: true, loading: false, error: null });
    try {
      const result = await this.api.control(engineId, agentId, action);
      if (!this.active || revision !== this.revision) return;
      this.publish({ snapshot: result, details: null, changing: false });
      await this.refresh();
    } catch (error) {
      if (revision === this.revision) this.publish({ error: message(error), changing: false });
    }
  }
  async remove(engineId: string, containerId: string, deleteData: boolean) {
    if (!this.active || this.state.changing || this.state.engineId !== engineId) throw new Error('The engine selection changed. Reopen deletion.');
    if (!this.api.remove) throw new Error('Container deletion is unavailable. Restart Cheshi.');
    const revision = ++this.revision;
    this.refreshing = false;
    this.publish({ changing: true, loading: false, error: null });
    try {
      await this.api.remove({ engineId, containerId, deleteData });
      if (!this.active || revision !== this.revision) return;
      this.publish({ changing: false, snapshot: this.state.snapshot ? { ...this.state.snapshot,
        agents: this.state.snapshot.agents.filter(agent => agent.id !== containerId) } : null,
        agentId: this.state.agentId === containerId ? '' : this.state.agentId,
        details: this.state.details?.agent.id === containerId ? null : this.state.details });
      await this.refresh();
    } catch (error) {
      if (revision === this.revision) this.publish({ changing: false, error: message(error) });
      throw error;
    }
  }
}
