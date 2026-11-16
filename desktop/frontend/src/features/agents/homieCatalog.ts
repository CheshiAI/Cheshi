import type { AgentModel } from '../../../../shared/agent-models';
import type { CodexAccountProfile, CodexAccountsApi, CodexAccountsSnapshot } from '../../../../shared/codex-accounts';

export type HomieAccountsApi = Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
export interface ModelCatalog {
  accountId: string | null; models: AgentModel[]; loading: boolean; refreshing: boolean; error: string | null;
}
interface ModelEntry { state: ModelCatalog; expires: number; flight?: Promise<AgentModel[]>; }
const emptyModels: ModelCatalog = { accountId: null, models: [], loading: false, refreshing: false, error: null };
const lifetime = 60_000;
const identity = (account: CodexAccountProfile) => JSON.stringify([account.email, account.usage.authenticated, account.login.state]);

/** Workspace-scoped UI data. Authentication and model support are still checked when saving. */
export class HomieCatalog {
  private readonly load: (id: string) => Promise<AgentModel[]>;
  private readonly now: () => number;
  private readonly entries = new Map<string, ModelEntry>();
  private readonly listeners = new Set<() => void>();
  private accountsApi?: HomieAccountsApi;
  private unsubscribeAccounts?: () => void;
  private accountsFlight?: Promise<void>;
  private accountsExpires = 0;
  private accountsRevision = 0;
  private accountsKnown = false;
  private disposed = false;
  private accounts = { profiles: [] as CodexAccountProfile[], loading: false, error: null as string | null };
  constructor(load: (id: string) => Promise<AgentModel[]>, now: () => number = Date.now) { this.load = load; this.now = now; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { if (!this.disposed) for (const listener of this.listeners) listener(); }
  private entry(id: string): ModelEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { state: { ...emptyModels, accountId: id }, expires: 0 };
      this.entries.set(id, entry);
    }
    return entry;
  }
  modelSnapshot = (id: string | null): ModelCatalog => id ? this.entry(id).state : emptyModels;
  accountsSnapshot = () => this.accounts;
  connectAccounts(api: HomieAccountsApi) {
    if (this.disposed || this.accountsApi === api) return;
    this.unsubscribeAccounts?.();
    this.accountsApi = api;
    this.accountsRevision++;
    this.accountsFlight = undefined;
    this.accountsExpires = 0;
    this.accountsKnown = false;
    this.entries.clear();
    this.accounts = { profiles: [], loading: false, error: null };
    this.unsubscribeAccounts = api.onDidChange(snapshot => {
      if (this.accountsApi === api && !this.disposed) this.acceptAccounts(snapshot);
    });
    this.publish();
  }
  private acceptAccounts(snapshot: CodexAccountsSnapshot) {
    this.accountsRevision++;
    const next = new Map(snapshot.profiles.map(profile => [profile.id, profile]));
    for (const previous of this.accounts.profiles) {
      const current = next.get(previous.id);
      if (!current) this.entries.set(previous.id, { expires: 0, state: { ...emptyModels, accountId: previous.id, error: 'This account is unavailable.' } });
      else if (identity(previous) !== identity(current)) this.entries.delete(previous.id);
    }
    for (const profile of snapshot.profiles) {
      if (profile.usage.authenticated !== true) {
        this.entries.set(profile.id, { expires: 0, state: { ...emptyModels, accountId: profile.id,
          error: 'Sign in to this account before selecting a model.' } });
      }
    }
    this.accounts = { profiles: snapshot.profiles, loading: false, error: null };
    this.accountsKnown = true;
    this.accountsExpires = this.now() + lifetime;
    this.publish();
  }
  async ensureAccounts(force = false): Promise<void> {
    const api = this.accountsApi;
    if (!api || this.disposed) return;
    if (this.accountsFlight) return this.accountsFlight;
    if (!force && this.accountsExpires > this.now()) return;
    const revision = this.accountsRevision;
    this.accounts = { ...this.accounts, loading: this.accounts.profiles.length === 0, error: null };
    this.publish();
    const flight = Promise.resolve().then(() => api.list()).then(snapshot => {
      if (!this.disposed && api === this.accountsApi && revision === this.accountsRevision) this.acceptAccounts(snapshot);
    }, () => {
      if (!this.disposed && api === this.accountsApi && revision === this.accountsRevision) {
        this.accounts = { ...this.accounts, loading: false, error: 'Could not load accounts.' }; this.publish();
      }
    });
    this.accountsFlight = flight;
    try { await flight; } finally { if (this.accountsFlight === flight) this.accountsFlight = undefined; }
  }
  loadModels = (id: string, force = false): Promise<AgentModel[]> => {
    if (this.disposed) return Promise.reject(new Error('Homie settings are closed.'));
    const entry = this.entry(id);
    if (entry.flight) return entry.flight;
    if (!force && entry.expires > this.now()) return Promise.resolve(entry.state.models);
    const account = this.accounts.profiles.find(profile => profile.id === id);
    if (this.accountsKnown && !account) return Promise.reject(new Error('This account is unavailable.'));
    if (account && account.usage.authenticated !== true) return Promise.reject(new Error('Sign in to this account before selecting a model.'));
    entry.state = { ...entry.state, loading: entry.state.models.length === 0, refreshing: true, error: null };
    const flight = Promise.resolve().then(() => this.load(id)).then(models => {
      if (!this.disposed && this.entries.get(id) === entry) {
        entry.state = { accountId: id, models, loading: false, refreshing: false, error: null };
        entry.expires = this.now() + lifetime;
        this.publish();
      }
      return models;
    }, error => {
      if (!this.disposed && this.entries.get(id) === entry) {
        entry.state = { ...entry.state, loading: false, refreshing: false,
          error: error instanceof Error ? error.message : 'Could not load models.' };
        this.publish();
      }
      throw error;
    }).finally(() => { if (entry.flight === flight) entry.flight = undefined; });
    entry.flight = flight;
    this.publish();
    return flight;
  };
  dispose() {
    this.disposed = true; this.unsubscribeAccounts?.(); this.listeners.clear(); this.entries.clear();
  }
}
