import { FlashError, type FlashConnection } from './client.mts';
import type { FlashHost } from './runtime.mts';

interface FlashPreferences {
  getFlashEnabled(): boolean;
  subscribeFlashEnabled(listener: (enabled: boolean) => void): () => void;
}

/** One app-wide switch owns the service; consumers cannot restart it while disabled. */
export class FlashControl {
  private active: boolean;
  private closed = false;
  private lifetime = new AbortController();
  private host: FlashHost | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private readonly createHost: () => FlashHost;

  constructor(preferences: FlashPreferences, createHost: () => FlashHost) {
    this.createHost = createHost;
    this.active = preferences.getFlashEnabled() === true;
    this.unsubscribe = preferences.subscribeFlashEnabled(enabled => {
      if (this.closed || this.active === enabled) return;
      this.lifetime.abort(new FlashError('disabled', 'Flash usage changed. Retry if enabled.'));
      this.lifetime = new AbortController();
      this.active = enabled === true;
      if (!this.active) this.retire();
      for (const listener of this.listeners) listener();
    });
  }

  enabled(): boolean { return this.active && !this.closed; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>, caller: AbortSignal): Promise<T> {
    if (!this.enabled()) throw new FlashError('disabled', 'Flash is off. Enable it in Settings > Flash to use memory.');
    const signal = AbortSignal.any([caller, this.lifetime.signal]);
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }).then(value => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(signal.reason); else resolve(value);
      }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }

  acquire(): FlashHost {
    const lease = new AbortController();
    return {
      transaction: <T,>(operation: (connection: FlashConnection) => Promise<T>, caller: AbortSignal) =>
        this.run(async signal => {
          // Never start a replacement before the previous owned process has stopped.
          await this.stopping;
          signal.throwIfAborted();
          const host = this.host ??= this.createHost();
          return host.transaction(operation, signal);
        }, AbortSignal.any([caller, lease.signal])),
      release: async () => { lease.abort(); },
    };
  }

  private retire(): void {
    const host = this.host;
    this.host = null;
    if (host) this.stopping = this.stopping.then(() => host.release());
    // Preserve a shutdown failure for the next request without an unhandled rejection.
    void this.stopping.catch(() => {});
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    this.lifetime.abort();
    this.listeners.clear();
    this.retire();
    await this.stopping;
  }
}
