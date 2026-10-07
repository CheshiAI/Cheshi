import { resolve } from 'node:path';
import { normalizeChatHistoryFilePath } from './chat-history-compiler.mts';
import { ChatHistoryIndexStore } from './chat-history-index-store.mts';
import { chatHistorySearchRequest } from '../shared/chat-history-search.ts';
import type { ChatHistorySearchResponse } from '../shared/chat-history-search.ts';
import type { SearchSource } from './chat-search-source.mts';
import { ChatSearchService } from './chat-search-service.mts';

interface HistorySearchOptions { directory: string; cwd: string; source: SearchSource; now?(): number }

/** Indexes persisted parent conversations using read-only history requests, never model calls. */
export class ChatHistorySearch {
  private readonly store: ChatHistoryIndexStore;
  private readonly cwd: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly deletedIds = new Set<string>();
  private readonly index: ChatSearchService;

  constructor(options: HistorySearchOptions) {
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

  /** Mark immediately so an in-flight refresh cannot resurrect a deleted session. */
  remove(threadIds: readonly string[]): Promise<void> {
    for (const id of threadIds) this.deletedIds.add(id);
    const indexed = this.index.remove(threadIds);
    return Promise.all([indexed, this.enqueue(() => this.store.removeThreads(this.deletedIds))]).then(() => undefined);
  }

  stop(): Promise<void> {
    return Promise.all([this.queue, this.index.stop()]).then(() => undefined);
  }
}
