import { randomUUID } from 'node:crypto';
import type { FlashMemoryStatus } from '../../shared/flash-memory.ts';
import { waitForSync } from './wait.mts';
import type { CodexAccountsSnapshot } from '../../shared/codex-accounts.ts';
import type { SearchSource } from '../chat-search-source.mts';
import type { JsonObject } from '../codex-chat-types.mts';
import { callFlash, FlashError } from './client.mts';
import type { FlashHost } from './runtime.mts';
import { digest, FlashSources, reconcileSources, type FlashBinding, type FlashSource } from './sources.mts';

export interface SessionMemory {
  execute(method: string, params: Record<string, unknown>, session: string, signal: AbortSignal): Promise<unknown>;
}

export class FlashSessionMemory implements SessionMemory {
  private readonly options: { workspace: string; source: SearchSource; host: FlashHost; syncWaitMs?: number; blocked?(): boolean; onError?(code: string): void };
  private readonly sources: FlashSources;
  private binding: FlashBinding | null = null;
  private lifetime = new AbortController();
  private syncing: Promise<void> | null = null;
  private readonly cleanupLifetime = new AbortController();
  private readonly removals = new Map<string, Promise<void>>();
  private synced = new Map<string, FlashSource>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private progress: Omit<FlashMemoryStatus, 'waiting'> = { state: 'signed_out', processed: 0, total: null, error: null };
  private readonly waiters = new Set<symbol>();

  status(): FlashMemoryStatus { return { ...this.progress, waiting: this.waiters.size }; }

  retry(): FlashMemoryStatus {
    if (!this.binding || this.closed) return this.status();
    void this.synchronize().catch(() => {});
    return this.status();
  }
  constructor(options: FlashSessionMemory['options']) {
    this.options = options;
    this.sources = new FlashSources({ cwd: options.workspace, source: options.source });
  }

  accounts(snapshot: CodexAccountsSnapshot): void {
    const profile = snapshot.profiles.find(item => item.id === snapshot.activeId);
    const next = profile?.usage.authenticated === true
      ? { profileId: profile.id, account: digest([profile.id, profile.email]) } : null;
    if (next?.account === this.binding?.account) return;
    this.invalidate();
    this.binding = next;
    this.sources.clear();
    this.schedule();
  }

  resetAccount(): void { this.invalidate(); this.binding = null; this.sources.clear(); }

  private invalidate(): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.syncing = null;
    this.synced.clear();
    clearTimeout(this.timer);
    this.waiters.clear();
    this.progress = { state: 'signed_out', processed: 0, total: null, error: null };
  }

  changed(event: JsonObject): void {
    if (!['sessions-changed', 'sessions-deleted', 'session-created', 'turn-completed'].includes(String(event.type))) return;
    this.invalidate();
    if (event.type === 'sessions-deleted' && Array.isArray(event.threadIds)) {
      const ids = event.threadIds.filter((id): id is string => typeof id === 'string');
      if (ids.length) void this.remove(ids).catch(() => this.options.onError?.('delete_pending'));
    }
    this.schedule();
  }

  remove(threadIds: readonly string[]): Promise<void> {
    if (!threadIds.length) return Promise.resolve();
    const ids = [...new Set(threadIds)].sort();
    const key = JSON.stringify(ids);
    const pending = this.removals.get(key);
    if (pending) return pending;
    // Cleanup is workspace-wide and must survive an account switch or duplicate pane event.
    const signal = this.cleanupLifetime.signal;
    const operation = this.options.host.transaction(async connection => {
      let { generation } = await callFlash<{ generation: number }>(connection, 'status', {}, signal);
      for (let start = 0; start < ids.length; start += 1000) {
        ({ generation } = await callFlash<{ generation: number }>(connection, 'sessions.delete', {
          workspace: this.options.workspace, session_ids: ids.slice(start, start + 1000), expected_generation: generation,
        }, signal));
      }
    }, signal);
    this.removals.set(key, operation);
    void operation.finally(() => { this.removals.delete(key); }).catch(() => {});
    return operation;
  }

  private schedule(): void {
    if (this.closed || !this.binding) return;
    this.progress = { state: 'preparing', processed: 0, total: null, error: null };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.synchronize().catch(error => {
        if (!this.closed) this.options.onError?.(error instanceof FlashError ? error.code : 'sync_failed');
      });
    }, 1000);
    this.timer.unref();
  }

  synchronize(): Promise<void> {
    if (this.closed || !this.binding) return Promise.reject(new FlashError('unavailable', 'Sign in to use session memory'));
    if (this.syncing) return this.syncing;
    clearTimeout(this.timer);
    this.progress = { state: 'preparing', processed: 0, total: null, error: null };
    const binding = this.binding;
    const signal = this.lifetime.signal;
    const operation = this.options.host.transaction(async connection => {
      this.assertCurrent(binding, signal);
      this.progress = { state: 'syncing', processed: 0, total: null, error: null };
      const sources = await this.sources.collect(binding, signal);
      const synced = await reconcileSources(connection, this.options.workspace, binding, sources, signal, (processed, total) => {
        this.assertCurrent(binding, signal);
        this.progress = { state: 'syncing', processed, total, error: null };
      });
      this.assertCurrent(binding, signal);
      this.synced = synced;
      this.progress = { state: 'ready', processed: sources.length, total: sources.length, error: null };
    }, signal).catch(error => {
      if (!signal.aborted && this.binding === binding && !this.closed) {
        const errorMessage = this.progress.state === 'preparing'
          ? 'Flash could not start. Check the local Flash installation and offline model, then retry.'
          : 'Saved conversations could not finish synchronizing. Retry; if this persists, check Flash diagnostics.';
        this.progress = { ...this.progress, state: 'error', error: errorMessage };
      }
      throw error;
    });
    this.syncing = operation;
    void operation.finally(() => { if (this.syncing === operation) this.syncing = null; }).catch(() => {});
    return operation;
  }

  private assertCurrent(binding: FlashBinding, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closed || this.binding !== binding || this.options.blocked?.()) {
      throw new FlashError('stale_source', 'The account or conversation state changed. Retry.');
    }
  }

  async execute(method: string, params: Record<string, unknown>, session: string, caller: AbortSignal): Promise<unknown> {
    if (!['memory_search', 'memory_read'].includes(method)) throw new FlashError('invalid_request', 'Unknown memory tool');
    const binding = this.binding;
    if (!binding) throw new FlashError('unavailable', 'Sign in to use session memory');
    const signal = AbortSignal.any([caller, this.lifetime.signal]);
    signal.throwIfAborted();
    const waiter = Symbol();
    this.waiters.add(waiter);
    try { await waitForSync(this.synchronize(), signal, this.options.syncWaitMs ?? 300_000); }
    finally { this.waiters.delete(waiter); }
    this.assertCurrent(binding, signal);
    return this.options.host.transaction(async connection => {
      this.assertCurrent(binding, signal);
      const scope = { workspace: this.options.workspace, account: binding.account, homie: `session:${session}:${randomUUID()}` };
      const grant = await callFlash<{ token: string }>(connection, 'grant.create', { ...scope, ttl_seconds: 60 }, signal);
      try {
        const result = await callFlash({ ...connection, token: grant.token }, method, params, signal);
        await this.sources.verify(binding, result, this.synced);
        this.assertCurrent(binding, signal);
        return result;
      } finally {
        // A canceled request still retires its credential; TTL bounds cleanup failures.
        await callFlash({ ...connection, timeoutMs: 2000 }, 'grant.revoke', scope).catch(() => {});
      }
    }, signal);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.invalidate();
    this.cleanupLifetime.abort();
    await this.options.host.release();
  }
}
