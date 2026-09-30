import { resolve } from 'node:path';
import { SearchWorkerClient } from './chat-search-worker-client.mts';
import { historyFingerprint, searchSessions, type SearchSource } from './chat-search-source.mts';
import type { IndexedSession } from './chat-search-index.mts';
import type { chatHistorySearchRequest, ChatHistorySearchResponse } from '../shared/chat-history-search.ts';

interface Options { directory: string; cwd: string; source: SearchSource; now?(): number }
interface IndexState { sessions: IndexedSession[]; ready: boolean; updatedAt?: number; unavailableSessions?: string[] }
const SYNC_INTERVAL_MS = 30_000;
const WITHOUT_FINGERPRINT_RECHECK_MS = 300_000;

/** The read worker stays available while the write worker synchronizes changed histories. */
export class ChatSearchService {
  private readonly options: Options;
  private writer: SearchWorkerClient | null = null;
  private reader: SearchWorkerClient | null = null;
  private initialized: Promise<void> | null = null;
  private syncing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private closing: Promise<void> | null = null;
  private lastAttempt = 0;
  private updatedAt = 0;
  private syncFailed = false;
  private seeded = false;
  private unavailable: string[] = [];
  private readonly deleted = new Set<string>();

  constructor(options: Options) { this.options = { ...options, cwd: resolve(options.cwd) }; }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Session search is closed.'));
    this.initialized ??= this.initialize().catch(async error => {
      await this.reader?.close(); await this.writer?.close();
      this.reader = null; this.writer = null; this.initialized = null;
      throw error;
    });
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    this.writer = new SearchWorkerClient(this.options.directory, this.options.cwd);
    const state = await this.writer.request<IndexState>({ type: 'sessions' });
    this.updatedAt = state.updatedAt ?? 0;
    this.unavailable = state.unavailableSessions ?? [];
    if (!state.ready) await this.sync(false, true);
    if (this.stopped) return;
    this.reader = new SearchWorkerClient(this.options.directory, this.options.cwd, true);
    this.timer = setInterval(() => this.backgroundSync(), SYNC_INTERVAL_MS);
    this.timer.unref();
    // The persisted index is immediately usable. Source validation is independent of a query.
    if (state.ready || this.seeded) this.backgroundSync();
  }

  private backgroundSync(): void {
    if (!this.stopped) void this.sync(false).catch(() => { /* Exposed in the next response; retry at the next tick. */ });
  }

  /** Event bursts coalesce; provider file fingerprints also catch out-of-process changes. */
  changed(event: { type?: unknown }): void {
    if (this.stopped || !this.initialized || !['turn-completed', 'turn-failed', 'background-turn-completed', 'background-turn-failed',
      'session-created', 'sessions-changed', 'sessions-loaded'].includes(String(event.type))) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; this.backgroundSync(); }, 500);
    this.debounce.unref();
  }

  async synchronize(force = false): Promise<void> {
    await this.start();
    // A force refresh must not accidentally join a weaker background check.
    if (force && this.syncing) await this.syncing.catch(() => undefined);
    await this.sync(force);
  }

  private sync(force: boolean, seed = false): Promise<void> {
    if (this.syncing) return this.syncing;
    this.lastAttempt = this.now();
    this.syncing = this.update(force, seed).then(() => { this.syncFailed = false; this.updatedAt = this.now(); }, error => {
      this.syncFailed = true; throw error;
    }).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async update(force: boolean, seed: boolean): Promise<void> {
    if (this.stopped || !this.writer) return;
    const writer = this.writer;
    const sessions = searchSessions(await this.options.source.list()).filter(session => !this.deleted.has(session.id));
    if (this.stopped) return;
    const state = await writer.request<IndexState>({ type: 'sessions' });
    const previous = new Map(state.sessions.map(session => [session.source_key, session]));
    const retained = new Set(sessions.map(session => session.sourceKey));
    await writer.request({ type: 'remove', keys: state.sessions.filter(session => !retained.has(session.source_key)).map(session => session.source_key) });
    const unavailable = new Set<string>();
    let next = 0;
    const load = async () => {
      while (next < sessions.length && !this.stopped) {
        const session = sessions[next++]!;
        if (this.deleted.has(session.id)) continue;
        const old = previous.get(session.sourceKey);
        try {
          if (seed && !old && await writer.request<boolean>({ type: 'seed', session })) { this.seeded = true; continue; }
          const fingerprint = await historyFingerprint(session);
          const now = this.now();
          const fallbackExpired = fingerprint === null && !!old && (now < old.checked_at || now - old.checked_at >= WITHOUT_FINGERPRINT_RECHECK_MS);
          const activeWithoutFingerprint = session.active && fingerprint === null;
          if (!force && old && old.revision === session.revision && old.fingerprint === fingerprint && !activeWithoutFingerprint && !fallbackExpired) continue;
          const raw = await this.options.source.read(session.id, session.profileId);
          const after = await historyFingerprint(session);
          if (this.deleted.has(session.id) || this.stopped) continue;
          // A concurrent append must cause another sync, never mark a partial read as up-to-date.
          await writer.request({ type: 'put', raw, session, now, fingerprint: fingerprint === after ? fingerprint : null });
          if (this.deleted.has(session.id)) await writer.request({ type: 'remove', keys: [session.sourceKey] });
        } catch {
          unavailable.add(session.id);
          await writer.request({ type: 'remove', keys: [session.sourceKey] });
        }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, sessions.length) }, load));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    this.unavailable = [...unavailable].filter(id => !this.deleted.has(id));
    if (!this.stopped) await writer.request({ type: 'ready', updatedAt: this.now(), unavailableSessions: this.unavailable });
  }

  async search(request: ReturnType<typeof chatHistorySearchRequest>): Promise<ChatHistorySearchResponse> {
    await this.start();
    if (this.stopped) throw new Error('Session search is closed.');
    if (request.refresh) await this.synchronize(true);
    else if (!request.cursor && this.now() - this.lastAttempt >= SYNC_INTERVAL_MS) this.backgroundSync();
    const updating = !!this.syncing || !!this.debounce;
    const indexedAt = this.updatedAt;
    const result = await this.reader!.request<ChatHistorySearchResponse>({ type: 'query', request, now: this.now() });
    if (this.stopped) throw new Error('Session search is closed.');
    // A deletion observed while SQL was running invalidates this result as well.
    if (result.hits.some(hit => this.deleted.has(hit.threadId))) throw new Error('Search results have changed. Refresh the search to continue.');
    return { ...result, unavailableSessions: this.unavailable,
      indexState: this.syncFailed ? 'error' : updating || this.syncing ? 'updating' : 'ready',
      ...(indexedAt ? { indexUpdatedAt: indexedAt } : {}) };
  }

  async remove(threadIds: readonly string[]): Promise<void> {
    for (const id of threadIds) this.deleted.add(id);
    if (!this.initialized) return;
    await this.initialized;
    if (!this.writer) return;
    const state = await this.writer.request<IndexState>({ type: 'sessions' });
    await this.writer.request({ type: 'remove', keys: state.sessions.filter(session => this.deleted.has(session.thread_id)).map(session => session.source_key) });
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.closing ??= (async () => {
      await this.initialized?.catch(() => undefined);
      await this.syncing?.catch(() => undefined);
      await this.reader?.close(); await this.writer?.close();
    })();
    return this.closing;
  }
}
