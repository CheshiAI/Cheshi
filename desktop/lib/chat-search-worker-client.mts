import { Worker } from 'node:worker_threads';
import type { SearchSession } from './chat-search-source.mts';
import type { chatHistorySearchRequest } from '../shared/chat-history-search.ts';

export type SearchWorkerRequest =
  | { type: 'sessions' | 'close' }
  | { type: 'ready'; updatedAt: number; unavailableSessions: string[] }
  | { type: 'seed'; session: SearchSession }
  | { type: 'put'; session: SearchSession; raw: unknown; fingerprint: string | null; now: number }
  | { type: 'remove'; keys: string[] }
  | { type: 'query'; request: ReturnType<typeof chatHistorySearchRequest>; now: number };

/** Heavy parsing, tokenization and SQL run outside Electron's main thread. */
export class SearchWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private next = 0;
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;

  constructor(directory: string, cwd: string, readonly = false) {
    this.worker = new Worker(new URL('./chat-search-worker.mts', import.meta.url), {
      workerData: { directory, cwd, readonly },
      // A parent launched with --input-type=module must not pass that flag to a file worker.
      execArgv: process.execArgv.filter(value => !value.startsWith('--input-type') && !value.startsWith('--inspect')),
    });
    this.worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const task = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!this.pending.size) this.worker.unref();
      if (message.error) task?.reject(new Error(message.error)); else task?.resolve(message.result);
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => this.fail(new Error(`Search worker closed (${code}).`)));
    this.worker.unref();
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }

  request<T>(request: SearchWorkerRequest): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    this.worker.ref();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      try { this.worker.postMessage({ id, request }); }
      catch (error) { this.pending.delete(id); if (!this.pending.size) this.worker.unref(); reject(error); }
    });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      try { if (!this.failure) await this.request({ type: 'close' }); }
      finally { await this.worker.terminate(); }
    })();
    return this.closing;
  }
}
