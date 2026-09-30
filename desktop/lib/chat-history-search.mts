import { resolve } from 'node:path';
import { normalizeChatHistoryFilePath } from './chat-history-compiler.mts';
import { ChatHistoryIndexStore, type ChatHistoryIndexRecord } from './chat-history-index-store.mts';
import { chatHistorySearchRequest } from '../shared/chat-history-search.ts';
import type { ChatHistorySearchResponse } from '../shared/chat-history-search.ts';
import { compileSearchRecord, searchSessions, type SearchSession, type SearchSource } from './chat-search-source.mts';
import { ChatSearchService } from './chat-search-service.mts';

interface HistorySearchOptions { directory: string; cwd: string; source: SearchSource; now?(): number }

/** Indexes persisted parent conversations using read-only history requests, never model calls. */
export class ChatHistorySearch {
  private readonly options: HistorySearchOptions;
  private readonly store: ChatHistoryIndexStore;
  private readonly cwd: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly deletedIds = new Set<string>();
  private stopped = false;
  private readonly index: ChatSearchService;

  constructor(options: HistorySearchOptions) {
    this.options = options;
    this.cwd = resolve(options.cwd);
    this.store = new ChatHistoryIndexStore(options.directory);
    this.index = new ChatSearchService(options);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  search(value: unknown): Promise<ChatHistorySearchResponse> {
    const request = chatHistorySearchRequest(value);
    const filePath = request.filePath ? normalizeChatHistoryFilePath(request.filePath, this.cwd) : '';
    if (request.filePath && !filePath) throw new TypeError('Choose a file within the current workspace.');
    return this.index.search({ ...request, filePath: filePath || '' });
  }

  start(): Promise<void> { return this.index.start(); }
  synchronize(force = false): Promise<void> { return this.index.synchronize(force); }
  changed(event: { type?: unknown }): void { this.index.changed(event); }

  /** Always revalidate recall sources; never serve evidence from an inaccessible cached conversation. */
  readRecords(threadIds?: readonly string[], signal?: AbortSignal) {
    return this.enqueue(() => this.loadRecords(threadIds, signal));
  }

  private async loadRecords(threadIds?: readonly string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.stopped) throw new Error('Session search is closed.');
    const sessions = searchSessions(await this.options.source.list()).filter(session => !this.deletedIds.has(session.id));
    await this.store.retain(sessions.map(session => session.sourceKey));
    const records: Array<ChatHistoryIndexRecord | undefined> = new Array(sessions.length);
    const unavailable: Array<string | undefined> = new Array(sessions.length);
    const unavailableSessions = threadIds?.filter(id => !sessions.some(session => session.id === id)) ?? [];
    const now = this.options.now?.() ?? Date.now();
    const load = async (session: SearchSession, index: number) => {
      signal?.throwIfAborted();
      if (threadIds && !threadIds.includes(session.id)) return;
      if (this.stopped) throw new Error('Session search is closed.');
      if (this.deletedIds.has(session.id)) return;
      let record: ChatHistoryIndexRecord;
      try {
        const raw = await this.options.source.read(session.id, session.profileId);
        record = compileSearchRecord(raw, this.cwd, session, now);
      } catch {
        // Recall evidence must remain accessible in the original account.
        unavailable[index] = session.id;
        await this.store.remove(session.sourceKey);
        return;
      }
      if (this.deletedIds.has(session.id)) return;
      await this.store.save(record);
      if (!this.deletedIds.has(session.id)) records[index] = record;
    };
    let next = 0;
    const worker = async () => {
      while (next < sessions.length) {
        const index = next++;
        await load(sessions[index]!, index);
      }
    };
    // Drain all workers before releasing the queue, even when storage or cancellation fails.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(4, sessions.length) }, worker));
    const failure = workers.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    signal?.throwIfAborted();
    if (this.stopped) throw new Error('Session search is closed.');
    const available = records.filter((record): record is ChatHistoryIndexRecord => !!record && !this.deletedIds.has(record.thread.threadId));
    return { records: available, unavailableSessions: [...unavailableSessions, ...unavailable.filter((id): id is string => id !== undefined)]
      .filter(id => !this.deletedIds.has(id)) };
  }

  /** Mark immediately so an in-flight refresh cannot resurrect a deleted session. */
  remove(threadIds: readonly string[]): Promise<void> {
    for (const id of threadIds) this.deletedIds.add(id);
    const indexed = this.index.remove(threadIds);
    return Promise.all([indexed, this.enqueue(() => this.store.removeThreads(this.deletedIds))]).then(() => undefined);
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.all([this.queue, this.index.stop()]).then(() => undefined);
  }
}
