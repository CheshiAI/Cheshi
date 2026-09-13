import type { CodexAccountProfile } from '../shared/codex-accounts.ts';
import { CodexAccountService } from './codex-account-service.mts';
import type { CodexAppServerClient } from './codex-app-server-client.mts';
import { WorkspaceCodexLoginService } from './workspace-codex-login.mts';

export type CodexProfileClient = Pick<CodexAppServerClient, 'start' | 'stop' | 'request' | 'onNotification' | 'onDidFail'>;

function emailFromAccount(value: unknown): string | null {
  const response = value as { account?: { type?: unknown; email?: unknown } | null } | null;
  return response?.account?.type === 'chatgpt' && typeof response.account.email === 'string'
    ? response.account.email : null;
}

/** One managed login and usage client. No tokens cross this boundary. */
export class CodexAccountProfileSession {
  private readonly client: CodexProfileClient;
  private readonly account: CodexAccountService;
  private readonly login: WorkspaceCodexLoginService;
  private readonly changed: () => void;
  private readonly unsubscribe: (() => void)[];
  private current: CodexAccountProfile;
  private refreshFlight: Promise<void> | null = null;
  private refreshPending = false;
  private closing: Promise<void> | null = null;
  private disposed = false;
  private loggingOut = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private revision = 0;

  async historyRequest(method: 'thread/list' | 'thread/read' | 'thread/delete' | 'thread/goal/get', params: unknown): Promise<unknown> {
    this.assertOpen();
    if (this.loggingOut) throw new Error('Wait for account logout to finish.');
    return this.client.request(method, params);
  }

  constructor(options: {
    id: string; label: string; client: CodexProfileClient;
    openExternal(url: string): Promise<unknown>; changed(): void; loginTimeoutMs?: number;
  }) {
    this.client = options.client;
    this.changed = options.changed;
    this.current = {
      id: options.id, label: options.label, email: null,
      usage: { state: 'stopped', authenticated: false, plan: null, rateLimits: [], error: null },
      login: { state: 'checking', error: null },
    };
    const client: CodexProfileClient = {
      start: async () => { this.assertOpen(); return await this.client.start(); },
      request: async (method, params) => {
        this.assertOpen();
        const value = await this.client.request(method, params);
        if (!this.disposed && method === 'account/read') this.current.email = emailFromAccount(value);
        return value;
      },
      stop: async () => {}, // This session owns the shared process and stops it once.
      onNotification: (listener) => this.client.onNotification(listener),
      onDidFail: (listener) => this.client.onDidFail(listener),
    };
    this.account = new CodexAccountService({ client });
    this.login = new WorkspaceCodexLoginService({
      client, openExternal: options.openExternal, loginTimeoutMs: options.loginTimeoutMs,
    });
    this.unsubscribe = [
      this.account.onDidChange((usage) => {
        if (this.disposed) return;
        this.current.usage = usage;
        this.changed();
      }),
      client.onNotification((notification) => {
        if (notification.method === 'account/login/completed' || notification.method === 'account/updated') {
          this.refreshPending = true;
          void this.refresh();
        }
      }),
    ];
  }

  snapshot(): CodexAccountProfile { return structuredClone(this.current); }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Codex account session is closed.');
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.loggingOut) return;
    if (this.refreshFlight) return await this.refreshFlight;
    this.refreshPending = false;
    const revision = this.revision;
    const operation = (async () => {
      try {
        const [usage, login] = await Promise.all([this.account.getStatus(), this.login.getStatus()]);
        if (this.disposed) return;
        this.current.usage = usage;
        if (revision === this.revision) {
          this.current.login = login;
          if (login.state !== 'signing_in') this.stopPolling();
        }
        this.changed();
      } catch {
        if (this.disposed) return;
        this.current.usage = {
          ...this.current.usage, state: 'error', error: 'Could not refresh this Codex account. Please try again.',
        };
        this.changed();
      }
    })();
    this.refreshFlight = operation;
    try { await operation; }
    finally {
      if (this.refreshFlight === operation) this.refreshFlight = null;
      if (this.refreshPending && !this.disposed) void this.refresh();
    }
  }

  async startLogin(): Promise<void> {
    this.assertOpen();
    this.revision += 1;
    this.current.login = { state: 'signing_in', error: null };
    this.changed();
    const state = await this.login.startLogin();
    if (this.disposed) return;
    this.current.login = state;
    if (state.state === 'signing_in' && !this.poll) {
      this.poll = setInterval(() => { void this.refresh(); }, 1_000);
      this.poll.unref();
    }
    await this.refresh();
  }

  async cancelLogin(): Promise<void> {
    this.assertOpen();
    this.revision += 1;
    this.stopPolling();
    const state = await this.login.cancelLogin();
    if (this.disposed) return;
    this.current.login = state;
    this.changed();
  }

  async logout(): Promise<void> {
    this.assertOpen();
    await this.cancelLogin();
    this.loggingOut = true;
    try {
      // Drain stale reads before clearing authentication and invalidate account caches.
      await this.refreshFlight;
      await this.account.stop();
      this.assertOpen();
      await this.client.start();
      await this.client.request('account/logout');
      this.assertOpen();
      this.current.email = null;
      this.current.login = { state: 'signed_out', error: null };
      this.current.usage = { state: 'login_required', authenticated: false, plan: null, rateLimits: [], error: null };
      this.changed();
    } finally {
      this.loggingOut = false;
      await this.refresh();
    }
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  async dispose(): Promise<void> {
    if (this.closing) return await this.closing;
    this.disposed = true;
    this.stopPolling();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    const operation = Promise.all([this.login.dispose(), this.account.stop(), this.client.stop()]).then(() => {});
    this.closing = operation;
    await operation;
  }
}
