import { rankWithRecovery } from './ranking-recovery.mts';
import type { RerankMemory } from './rerank.mts';
import { parseMemoryTurns, validateSummary, type SummarizeMemory, type TurnReference } from './summary.mts';
import { randomUUID } from 'node:crypto';
import type { FlashMemoryStatus } from '../../shared/flash-memory.ts';
import { waitForSync } from './wait.mts';
import type { CodexAccountsSnapshot } from '../../shared/codex-accounts.ts';
import type { SearchSource } from '../chat-search-source.mts';
import type { JsonObject } from '../codex-chat-types.mts';
import { callFlash, FlashError } from './client.mts';
import type { FlashHost } from './runtime.mts';
import { digest, FlashSources, reconcileSources, sourceOwner, workspaceMemoryAccount, type FlashBinding, type FlashSource } from './sources.mts';

export interface SessionMemory {
  searchCandidates?(params: Record<string, unknown>, session: string, signal: AbortSignal, turnId?: string): Promise<unknown>;
  execute(method: string, params: Record<string, unknown>, session: string, signal: AbortSignal, turnId?: string): Promise<unknown>;
}

export class FlashSessionMemory implements SessionMemory {
  private readonly options: { workspace: string; source: SearchSource; host: FlashHost; syncWaitMs?: number; summarize?: SummarizeMemory; rerank?: RerankMemory;
    blocked?(): boolean; onError?(code: string): void };
  private readonly sources: FlashSources;
  private binding: FlashBinding | null = null;
  private bindings: readonly FlashBinding[] = [];
  private registered: readonly string[] = [];
  private hasConnected = false;
  private lifetime = new AbortController();
  private requests = new AbortController();
  private syncing: Promise<void> | null = null;
  private readonly cleanupLifetime = new AbortController();
  private readonly removals = new Map<string, Promise<void>>();
  private synced = new Map<string, FlashSource>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private progress: Omit<FlashMemoryStatus, 'waiting'> = { state: 'signed_out', processed: 0, total: null, error: null };
  private readonly waiters = new Set<symbol>();

  hasAccount(profileId: string): boolean { return !this.closed && this.bindings.some(b => b.profileId === profileId); }

  async original(target: { threadId: string; itemId: string }): Promise<string> {
    const binding = this.binding, signal = AbortSignal.any([this.lifetime.signal, this.requests.signal]);
    if (!binding) throw new FlashError('unavailable', 'Sign in to read the original.');
    const session = (await this.sources.sessions(this.bindings)).find(s => s.id === target.threadId);
    if (!session) throw new FlashError('stale_source', 'The source is unavailable.');
    const entry = (await this.sources.documents(session, true)).find(s => s.document.itemId === target.itemId);
    this.assertCurrent(binding, signal);
    if (!entry) throw new FlashError('stale_source', 'The source is unavailable.');
    return entry.document.text;
  }

  status(): FlashMemoryStatus { return { ...this.progress, waiting: this.waiters.size }; }

  retry(): FlashMemoryStatus {
    if (!this.bindings.length || this.closed) return this.status();
    void this.synchronize().catch(() => {});
    return this.status();
  }
  constructor(options: FlashSessionMemory['options']) {
    this.options = options;
    this.sources = new FlashSources({ cwd: options.workspace, source: options.source });
  }

  accounts(snapshot: CodexAccountsSnapshot): void {
    const bindings = snapshot.profiles.filter(profile => profile.usage.authenticated === true)
      .map(profile => ({ profileId: profile.id, account: digest([profile.id, profile.email]) }))
      .sort((a, b) => a.profileId.localeCompare(b.profileId));
    const registered = snapshot.profiles.map(profile => profile.id).sort();
    if (bindings.length) this.hasConnected = true;
    if (JSON.stringify(bindings) === JSON.stringify(this.bindings) && JSON.stringify(registered) === JSON.stringify(this.registered)) {
      const next = this.bindings.find(binding => binding.profileId === snapshot.activeId) ?? null;
      if (next !== this.binding) {
        this.requests.abort();
        this.requests = new AbortController();
        this.binding = next;
      }
      return;
    }
    this.invalidate();
    this.binding = bindings.find(binding => binding.profileId === snapshot.activeId) ?? null;
    this.bindings = bindings;
    this.registered = registered;
    this.schedule();
  }

  resetAccount(): void { this.invalidate(); this.binding = null; this.bindings = []; this.sources.clear(); this.schedule(); }

  private invalidate(): void {
    this.requests.abort();
    this.requests = new AbortController();
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.syncing = null;
    this.synced.clear();
    clearTimeout(this.timer);
    this.waiters.clear();
    this.progress = { state: 'signed_out', processed: 0, total: null, error: null };
  }

  changed(event: JsonObject): void {
    // Catalog/creation notifications also arrive while a reply is being written.
    // Index new conversation content only once the turn has ended; deletion is immediate.
    if (!['sessions-deleted', 'turn-completed'].includes(String(event.type))) return;
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
    if (this.closed || !this.hasConnected) return;
    this.progress = { state: this.bindings.length ? 'preparing' : 'signed_out', processed: 0, total: null, error: null };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.synchronizeSnapshot().catch(error => {
        if (!this.closed) this.options.onError?.(error instanceof FlashError ? error.code : 'sync_failed');
      });
    }, 1000);
    this.timer.unref();
  }

  synchronize(): Promise<void> {
    if (this.closed || !this.bindings.length) return Promise.reject(new FlashError('unavailable', 'Sign in to use session memory'));
    return this.synchronizeSnapshot();
  }

  private synchronizeSnapshot(): Promise<void> {
    if (this.syncing) return this.syncing;
    clearTimeout(this.timer);
    const bindings = this.bindings;
    this.progress = { state: bindings.length ? 'preparing' : 'signed_out', processed: 0, total: null, error: null };
    const registered = this.registered;
    const signal = this.lifetime.signal;
    const operation = this.options.host.transaction(async connection => {
      this.assertSyncCurrent(bindings, signal);
      this.progress = { state: bindings.length ? 'syncing' : 'signed_out', processed: 0, total: null, error: null };
      const groups = bindings.length ? await this.sources.collect(bindings, signal) : [];
      const sources = groups.flatMap(group => group.sources);
      if (new Set(sources.map(source => source.source_id)).size !== sources.length) {
        throw new FlashError('stale_source', 'The conversation catalog contains duplicate sources. Retry.');
      }
      const synced = await reconcileSources(connection, this.options.workspace, workspaceMemoryAccount(this.options.workspace),
        sources, signal, (processed, total) => {
          this.assertSyncCurrent(bindings, signal);
          this.progress = { state: bindings.length ? 'syncing' : 'signed_out', processed, total, error: null };
        }, { owners: new Map(groups.flatMap(group => group.sources.map(source => [source.source_id, sourceOwner(group.binding)]))),
          authenticated: new Set(bindings.map(sourceOwner)), registered: new Set(registered) });
      this.assertSyncCurrent(bindings, signal);
      this.synced = synced;
      this.progress = { state: bindings.length ? 'ready' : 'signed_out', processed: sources.length, total: sources.length, error: null };
    }, signal).catch(error => {
      if (!signal.aborted && this.bindings === bindings && !this.closed) {
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

  private assertSyncCurrent(bindings: readonly FlashBinding[], signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closed || this.bindings !== bindings || this.options.blocked?.()) {
      throw new FlashError('stale_source', 'The accounts or conversation state changed. Retry.');
    }
  }

  private assertCurrent(binding: FlashBinding, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closed || this.binding !== binding || this.options.blocked?.()) {
      throw new FlashError('stale_source', 'The account or conversation state changed. Retry.');
    }
  }

  async verifyCandidates(matches: Record<string, unknown>[], caller: AbortSignal): Promise<void> {
    const binding = this.binding;
    if (!binding) throw new FlashError('unavailable', 'Sign in to verify memory.');
    const signal = AbortSignal.any([caller, this.lifetime.signal, this.requests.signal]);
    this.assertCurrent(binding, signal);
    await this.sources.verify(this.bindings, { matches }, this.synced);
    this.assertCurrent(binding, signal);
  }

  searchCandidates(params: Record<string, unknown>, session: string, signal: AbortSignal, turnId?: string): Promise<unknown> {
    return this.run('memory_search', params, session, signal, turnId, false);
  }
  execute(method: string, params: Record<string, unknown>, session: string, signal: AbortSignal, turnId?: string): Promise<unknown> {
    return this.run(method, params, session, signal, turnId, true);
  }
  private async run(method: string, params: Record<string, unknown>, session: string, caller: AbortSignal, turnId: string | undefined, rank: boolean): Promise<unknown> {
    if (!['memory_search', 'memory_read'].includes(method)) throw new FlashError('invalid_request', 'Unknown memory tool');
    const binding = this.binding;
    if (!binding) throw new FlashError('unavailable', 'Sign in to use session memory');
    const signal = AbortSignal.any([caller, this.lifetime.signal, this.requests.signal]);
    signal.throwIfAborted();
    // Ready data already represents the last completed turns. Reading it must not
    // start another catalog reconciliation or expose a transient syncing banner.
    if (this.progress.state !== 'ready') {
      const waiter = Symbol();
      this.waiters.add(waiter);
      try { await waitForSync(this.synchronize(), signal, this.options.syncWaitMs ?? 300_000); }
      finally { this.waiters.delete(waiter); }
    }
    this.assertCurrent(binding, signal);
    const searchParams = method === 'memory_search' && rank && this.options.rerank ? { ...params, limit: 30 } : params;
    const result = await this.options.host.transaction(async connection => {
      this.assertCurrent(binding, signal);
      const scope = { workspace: this.options.workspace, account: workspaceMemoryAccount(this.options.workspace), homie: `session:${session}:${randomUUID()}` };
      const grant = await callFlash<{ token: string }>(connection, 'grant.create', { ...scope, ttl_seconds: 60 }, signal);
      try {
        const request = method === 'memory_search' && turnId
          ? { ...searchParams, exclude_turn: { session_id: session, turn_id: turnId } } : searchParams;
        const result = await callFlash({ ...connection, token: grant.token },
          method === 'memory_read' ? 'memory_read_turns' : method,
          method === 'memory_read' ? { turns: params.turns } : request, signal);
        await this.sources.verify(this.bindings, result, this.synced);
        this.assertCurrent(binding, signal);
        return result;
      } finally {
        // A canceled request still retires its credential; TTL bounds cleanup failures.
        await callFlash({ ...connection, timeoutMs: 2000 }, 'grant.revoke', scope).catch(() => {});
      }
    }, signal);
    if (method !== 'memory_read') {
      if (!rank || !this.options.rerank) return result;
      const found = result as { matches: Record<string, unknown>[] };
      const ranked = await rankWithRecovery(params.query as string, found.matches, signal, this.options.rerank);
      this.assertCurrent(binding, signal);
      await this.sources.verify(this.bindings, result, this.synced);
      this.assertCurrent(binding, signal);
      return { ...found, ...ranked, matches: ranked.matches.slice(0, Number(params.limit ?? 10)) };
    }
    if (!this.options.summarize) throw new FlashError('unavailable', 'Memory summarization is not configured');
    const turns = parseMemoryTurns(result, params.turns as TurnReference[]);
    const summary = validateSummary(await this.options.summarize({ question: params.question as string, turns }, signal), turns);
    // Provider inference never holds Flash's serialized administrative transaction.
    this.assertCurrent(binding, signal);
    await this.sources.verify(this.bindings, result, this.synced);
    this.assertCurrent(binding, signal);
    return { ...summary, model: 'gpt-6-luna', effort: 'low' };
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.invalidate();
    this.cleanupLifetime.abort();
    await this.options.host.release();
  }
}
