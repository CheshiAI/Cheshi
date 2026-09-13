import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { product } from '../../config/product.mts';
import { DEFAULT_CODEX_ACCOUNT_ID, MAX_CODEX_ACCOUNT_PROFILES, type CodexAccountsSnapshot } from '../shared/codex-accounts.ts';
import { CodexAppServerClient } from './codex-app-server-client.mts';
import { CodexAccountProfileSession, type CodexProfileClient } from './codex-account-profiles-session.mts';
import { CodexAccountProfilesStore, type StoredCodexAccountProfile } from './codex-account-profiles-store.mts';

export interface CodexAccountProfilesOptions {
  directory: string;
  defaultHome: string;
  cwd: string;
  openExternal(url: string): Promise<unknown>;
  createClient?: (environment: Record<string, string | undefined>) => CodexProfileClient;
  loginTimeoutMs?: number;
}

const registries = new Map<string, CodexAccountProfiles>();

/** Each workspace acquires once and releases on close. */
export function getCodexAccountProfiles(options: CodexAccountProfilesOptions): CodexAccountProfiles {
  const key = resolve(options.directory);
  const existing = registries.get(key);
  if (existing) {
    existing.assertDefaultHome(options.defaultHome);
    existing.retain();
    return existing;
  }
  const service = new CodexAccountProfiles(options);
  registries.set(key, service);
  return service;
}

export async function disposeCodexAccountProfiles(): Promise<void> {
  await Promise.all([...registries.values()].map((service) => service.dispose()));
}

/** Profile metadata and account-only processes; selecting a profile belongs to each workspace. */
export class CodexAccountProfiles {
  private readonly options: CodexAccountProfilesOptions;
  private readonly store: CodexAccountProfilesStore;
  private readonly sessions = new Map<string, CodexAccountProfileSession>();
  private readonly listeners = new Set<(snapshot: CodexAccountsSnapshot) => void>();
  private stored: StoredCodexAccountProfile[] = [];
  private initialized: Promise<void> | null = null;
  private mutations: Promise<unknown> = Promise.resolve();
  private listFlight: Promise<CodexAccountsSnapshot> | null = null;
  private disposed = false;
  private closing: Promise<void> | null = null;
  private references = 1;

  constructor(options: CodexAccountProfilesOptions) {
    if (!isAbsolute(options.defaultHome)) throw new Error('Codex home must be an absolute path.');
    this.options = { ...options, defaultHome: resolve(options.defaultHome) };
    this.store = new CodexAccountProfilesStore(options.directory);
  }

  assertDefaultHome(home: string): void {
    if (resolve(home) !== this.options.defaultHome) throw new Error('Codex account registry has a different default home.');
  }

  retain(): void { this.assertOpen(); this.references += 1; }

  async release(): Promise<void> {
    if (this.disposed) return;
    this.references -= 1;
    if (this.references === 0) await this.dispose();
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Codex account profiles are closed.');
  }

  private async initialize(): Promise<void> {
    this.assertOpen();
    if (!this.initialized) {
      this.initialized = (async () => {
        this.stored = await this.store.load();
        this.assertOpen();
        this.addSession({ id: DEFAULT_CODEX_ACCOUNT_ID, label: 'Default account' });
        for (const profile of this.stored) {
          await this.store.verifyHome(profile.id);
          this.assertOpen();
          this.addSession(profile);
        }
      })();
    }
    await this.initialized;
    this.assertOpen();
  }

  private profileEnvironment(id: string): Record<string, string | undefined> {
    if (id === DEFAULT_CODEX_ACCOUNT_ID) return { CODEX_HOME: this.options.defaultHome };
    return {
      CODEX_HOME: this.store.home(id), CODEX_ACCESS_TOKEN: undefined,
      CODEX_API_KEY: undefined, OPENAI_API_KEY: undefined, CODEX_SQLITE_HOME: undefined,
    };
  }

  private addSession(profile: StoredCodexAccountProfile): void {
    const environment = this.profileEnvironment(profile.id);
    const client = this.options.createClient?.(environment) ?? new CodexAppServerClient({
      capabilities: { experimentalApi: true },
      command: {
        executable: process.env.CHESHI_CODEX?.trim() || 'codex',
        args: [
          ...(profile.id === DEFAULT_CODEX_ACCOUNT_ID ? [] : ['-c', 'cli_auth_credentials_store="file"']),
          'app-server', '--listen', 'stdio://',
        ], environment,
      },
      cwd: this.options.cwd,
      clientInfo: { name: product.internalName, title: product.displayName, version: product.version },
    });
    this.sessions.set(profile.id, new CodexAccountProfileSession({
      ...profile, client, openExternal: this.options.openExternal,
      changed: () => this.emit(), loginTimeoutMs: this.options.loginTimeoutMs,
    }));
  }

  snapshot(): CodexAccountsSnapshot {
    return { activeId: DEFAULT_CODEX_ACCOUNT_ID, profiles: [...this.sessions.values()].map((session) => session.snapshot()) };
  }

  onDidChange(listener: (snapshot: CodexAccountsSnapshot) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(this.snapshot());
  }

  async list(): Promise<CodexAccountsSnapshot> {
    await this.initialize();
    if (this.listFlight) return await this.listFlight;
    const operation = (async () => {
      await Promise.all([...this.sessions.values()].map((session) => session.refresh()));
      this.assertOpen();
      return this.snapshot();
    })();
    this.listFlight = operation;
    try { return await operation; }
    finally { if (this.listFlight === operation) this.listFlight = null; }
  }

  private async mutate(operation: () => Promise<CodexAccountsSnapshot>): Promise<CodexAccountsSnapshot> {
    const pending = this.mutations.catch(() => undefined).then(async () => {
      await this.initialize();
      return await operation();
    });
    this.mutations = pending;
    return await pending;
  }

  async add(): Promise<CodexAccountsSnapshot> {
    return await this.mutate(async () => {
      if (this.stored.length >= MAX_CODEX_ACCOUNT_PROFILES - 1) throw new Error('Up to 10 Codex accounts can be registered.');
      let number = 2;
      while (this.stored.some(profile => profile.label === `Account ${number}`)) number += 1;
      const profile = { id: randomUUID(), label: `Account ${number}` };
      await this.store.createHome(profile.id);
      this.assertOpen();
      const next = [...this.stored, profile];
      await this.store.save(next);
      this.assertOpen();
      this.stored = next;
      this.addSession(profile);
      await this.session(profile.id).refresh();
      this.assertOpen();
      this.emit();
      return this.snapshot();
    });
  }

  private session(id: string): CodexAccountProfileSession {
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!session) throw new Error('Unknown Codex account.');
    return session;
  }

  async login(id: string): Promise<CodexAccountsSnapshot> {
    return await this.mutate(async () => {
      const session = this.session(id);
      for (const profile of this.snapshot().profiles) {
        if (profile.id !== id && profile.login.state === 'signing_in') {
          throw new Error('Finish or cancel the other account login first.');
        }
      }
      if (id !== DEFAULT_CODEX_ACCOUNT_ID) await this.store.verifyHome(id);
      await session.startLogin();
      this.assertOpen();
      return this.snapshot();
    });
  }

  async cancelLogin(id: string): Promise<CodexAccountsSnapshot> {
    await this.initialize();
    await this.session(id).cancelLogin();
    this.assertOpen();
    return this.snapshot();
  }

  async logout(id: string): Promise<CodexAccountsSnapshot> {
    return this.mutate(async () => {
      const session = this.session(id);
      if (id !== DEFAULT_CODEX_ACCOUNT_ID) await this.store.verifyHome(id);
      await session.logout();
      this.assertOpen();
      return this.snapshot();
    });
  }

  async environment(id: string): Promise<Record<string, string | undefined>> {
    await this.initialize();
    this.session(id);
    if (id !== DEFAULT_CODEX_ACCOUNT_ID) await this.store.verifyHome(id);
    return this.profileEnvironment(id);
  }

  async historyHomes(): Promise<Array<{ id: string; home: string }>> {
    await this.initialize();
    return Promise.all([...this.sessions.keys()].map(async id => ({
      id, home: (await this.environment(id)).CODEX_HOME!,
    })));
  }

  async historyRequest(id: string, method: string, params?: unknown): Promise<unknown> {
    if (method !== 'thread/list' && method !== 'thread/read' && method !== 'thread/delete' && method !== 'thread/goal/get') {
      throw new Error('Unsupported account history operation.');
    }
    await this.environment(id);
    return this.session(id).historyRequest(method, params);
  }

  async cancelRegistration(id: string): Promise<CodexAccountsSnapshot> {
    return this.mutate(async () => {
      if (id === DEFAULT_CODEX_ACCOUNT_ID) throw new Error('The default account cannot be removed.');
      const session = this.session(id);
      await session.cancelLogin();
      await session.refresh();
      this.assertOpen();
      const profile = session.snapshot();
      if (profile.usage.authenticated || profile.login.state === 'signed_in') {
        throw new Error('This account has signed in. Its registration was kept.');
      }
      const next = this.stored.filter(profile => profile.id !== id);
      await this.store.save(next);
      this.assertOpen();
      this.stored = next;
      this.sessions.delete(id);
      // Cancel registration only; never erase authentication or conversation files.
      try { await session.dispose(); }
      finally { this.emit(); }
      return this.snapshot();
    });
  }

  async dispose(): Promise<void> {
    if (this.closing) return await this.closing;
    this.disposed = true;
    this.listeners.clear();
    if (registries.get(this.store.directory) === this) registries.delete(this.store.directory);
    const operation = Promise.all([...this.sessions.values()].map((session) => session.dispose())).then(() => {});
    this.closing = operation;
    await operation;
  }
}
