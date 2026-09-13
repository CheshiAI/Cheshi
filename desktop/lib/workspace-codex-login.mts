import type { WorkspaceCodexLoginState } from '../shared/workspace-management.ts';
import { CodexAppServerClient } from './codex-app-server-client.mts';
import { product } from '../../config/product.mts';

type LoginClient = Pick<CodexAppServerClient, 'start' | 'request' | 'stop' | 'onNotification' | 'onDidFail'>;

interface WorkspaceCodexLoginOptions {
  client: LoginClient;
  openExternal(url: string): Promise<unknown>;
  loginTimeoutMs?: number;
}

export function createWorkspaceCodexLoginService(options: {
  cwd: string;
  openExternal(url: string): Promise<unknown>;
}): WorkspaceCodexLoginService {
  return new WorkspaceCodexLoginService({
    client: new CodexAppServerClient({
      command: {
        executable: process.env.CHESHI_CODEX?.trim() || 'codex',
        args: ['app-server', '--listen', 'stdio://'],
        environment: {},
      },
      cwd: options.cwd,
      clientInfo: { name: product.internalName, title: product.displayName, version: product.version },
    }),
    openExternal: options.openExternal,
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function accountSignedIn(value: unknown): boolean {
  const response = record(value);
  if (response?.account === null) return false;
  const account = record(response?.account);
  if (account?.type === 'chatgpt' || account?.type === 'apiKey') return true;
  throw new Error('Invalid Codex account response.');
}

function loginResponse(value: unknown): { loginId: string; authUrl: string } {
  const response = record(value);
  if (response?.type !== 'chatgpt' || typeof response.loginId !== 'string' || !response.loginId
    || typeof response.authUrl !== 'string') throw new Error('Invalid Codex login response.');
  return { loginId: response.loginId, authUrl: response.authUrl };
}

function validatedAuthUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) {
    throw new Error('Invalid Codex login address.');
  }
  return url.href;
}

/** Owns an account-only app server. No workspace, thread, or logout operations. */
export class WorkspaceCodexLoginService {
  private readonly options: WorkspaceCodexLoginOptions;
  private current: WorkspaceCodexLoginState = { state: 'checking', error: null };
  private loginId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  private disposed = false;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshFlight: Promise<WorkspaceCodexLoginState> | null = null;
  private loginFlight: Promise<WorkspaceCodexLoginState> | null = null;
  private disposeFlight: Promise<void> | null = null;
  private readonly subscriptions: (() => void)[];

  constructor(options: WorkspaceCodexLoginOptions) {
    this.options = options;
    this.subscriptions = [
      options.client.onNotification((notification) => this.notification(notification)),
      options.client.onDidFail(() => {
        if (this.disposed) return;
        this.revision += 1;
        this.clearAttempt();
        this.current = { state: 'error', error: 'Could not connect to Codex. Please try again.' };
      }),
    ];
  }

  private snapshot(): WorkspaceCodexLoginState { return { ...this.current }; }

  private request(method: string, params: unknown): Promise<unknown> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      if (this.stopped) throw new Error('Codex login service stopped.');
      await this.options.client.start();
      if (this.stopped) throw new Error('Codex login service stopped.');
      return await this.options.client.request(method, params);
    });
    this.queue = operation;
    return operation;
  }

  async getStatus(): Promise<WorkspaceCodexLoginState> {
    if (this.disposed || this.loginFlight) return this.snapshot();
    if (this.refreshFlight) return await this.refreshFlight;
    const revision = this.revision;
    const operation = this.refresh(revision);
    this.refreshFlight = operation;
    try { return await operation; }
    finally { if (this.refreshFlight === operation) this.refreshFlight = null; }
  }

  private async refresh(revision: number): Promise<WorkspaceCodexLoginState> {
    try {
      const signedIn = accountSignedIn(await this.request('account/read', { refreshToken: false }));
      if (this.disposed || revision !== this.revision) return this.snapshot();
      if (signedIn) {
        const loginId = this.loginId;
        this.clearAttempt();
        this.current = { state: 'signed_in', error: null };
        if (loginId) await this.cancelOwned(loginId);
      } else if (!this.loginId && this.current.state !== 'error') {
        this.current = { state: 'signed_out', error: null };
      }
    } catch {
      if (!this.disposed && revision === this.revision) {
        const loginId = this.loginId;
        this.clearAttempt();
        this.current = { state: 'error', error: 'Could not check Codex login. Please try again.' };
        if (loginId) await this.cancelOwned(loginId);
      }
    }
    return this.snapshot();
  }

  async startLogin(): Promise<WorkspaceCodexLoginState> {
    if (this.disposed || this.loginId) return this.snapshot();
    if (this.loginFlight) return await this.loginFlight;
    const revision = ++this.revision;
    this.current = { state: 'signing_in', error: null };
    const operation = this.startAttempt(revision);
    this.loginFlight = operation;
    try { return await operation; }
    finally { if (this.loginFlight === operation) this.loginFlight = null; }
  }

  private async startAttempt(revision: number): Promise<WorkspaceCodexLoginState> {
    let ownedId: string | null = null;
    try {
      const signedIn = accountSignedIn(await this.request('account/read', { refreshToken: false }));
      if (this.disposed || revision !== this.revision) return this.snapshot();
      if (signedIn) {
        this.current = { state: 'signed_in', error: null };
        return this.snapshot();
      }
      const response = loginResponse(await this.request('account/login/start', { type: 'chatgpt' }));
      ownedId = response.loginId;
      if (this.disposed || revision !== this.revision) {
        await this.cancelOwned(ownedId);
        return this.snapshot();
      }
      this.loginId = ownedId;
      const url = validatedAuthUrl(response.authUrl);
      await this.options.openExternal(url);
      if (this.disposed || revision !== this.revision) return this.snapshot();
      this.timer = setTimeout(() => {
        if (this.disposed || revision !== this.revision) return;
        const cancellation = this.cancelLogin();
        const cancellationRevision = this.revision;
        void cancellation.then(() => {
          if (!this.disposed && this.revision === cancellationRevision) {
            this.current = { state: 'error', error: 'Codex login timed out. Please try again.' };
          }
        });
      }, this.options.loginTimeoutMs ?? 15 * 60_000);
      this.timer.unref();
    } catch {
      if (ownedId) await this.cancelOwned(ownedId);
      if (!this.disposed && revision === this.revision) {
        this.clearAttempt();
        this.current = { state: 'error', error: 'Could not start Codex login. Please try again.' };
      }
    }
    return this.snapshot();
  }

  private notification(notification: Record<string, unknown>): void {
    if (this.disposed) return;
    if (notification.method === 'account/updated') {
      void this.getStatus();
      return;
    }
    const params = record(notification.params);
    if (notification.method !== 'account/login/completed' || !this.loginId
      || params?.loginId !== this.loginId) return;
    this.revision += 1;
    this.clearAttempt();
    if (params.success !== true) {
      this.current = { state: 'error', error: 'Codex login did not complete. Please try again.' };
      return;
    }
    this.current = { state: 'checking', error: null };
    void this.refresh(this.revision);
  }

  private clearAttempt(): void {
    this.loginId = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async cancelOwned(loginId: string): Promise<void> {
    try { await this.request('account/login/cancel', { loginId }); }
    catch { /* Cancellation may race with app-server completion or shutdown. */ }
  }

  async cancelLogin(): Promise<WorkspaceCodexLoginState> {
    if (this.disposed) return this.snapshot();
    this.revision += 1;
    const loginId = this.loginId;
    this.clearAttempt();
    this.current = { state: 'signed_out', error: null };
    if (loginId) await this.cancelOwned(loginId);
    await this.loginFlight;
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    if (this.disposeFlight) return await this.disposeFlight;
    this.disposed = true;
    this.revision += 1;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    const loginId = this.loginId;
    this.clearAttempt();
    this.current = { state: 'signed_out', error: null };
    const operation = (async () => {
      if (loginId) await this.cancelOwned(loginId);
      await this.loginFlight;
      await this.queue.catch(() => undefined);
      this.stopped = true;
      await this.options.client.stop();
    })();
    this.disposeFlight = operation;
    return await operation;
  }
}
