import { Worker } from 'node:worker_threads';
import type { AppleNoteSummary, AppleNotesFolder } from '../shared/apple-notes.ts';
import type { NotesSearchRequest } from '../shared/apple-notes-search.ts';

export type NotesWorkerRequest =
  | { type: 'catalog' | 'clear' | 'close' }
  | { type: 'complete'; folders: AppleNotesFolder[] }
  | { type: 'put'; folderId: string; note: AppleNoteSummary & { plaintext?: string }; bodyReady: boolean }
  | { type: 'remove'; ids: string[] }
  | { type: 'query'; request: NotesSearchRequest };

/** Heavy parsing, tokenization and SQL run outside Electron's main thread. */
export class NotesSearchWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private next = 0;
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;

  constructor(filename: string) {
    this.worker = new Worker(new URL('./apple-notes-search-worker.mts', import.meta.url), {
      workerData: { filename },
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

  request<T>(request: NotesWorkerRequest): Promise<T> {
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
