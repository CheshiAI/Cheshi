import { parseFlashEnabled, type FlashReadiness } from '../../shared/settings.ts';
import { FlashError } from './client.mts';
import type { FlashHost } from './runtime.mts';

interface Preferences { getFlashEnabled(): boolean; setFlashEnabled(value: boolean): boolean }
interface Options {
  preferences: Preferences;
  inspect(): Promise<FlashReadiness>;
  createHost(): FlashHost;
}

/** Publish ON only after the same host used by memory consumers has loaded its model. */
export class FlashActivation {
  private readonly options: Options;
  private active = false;
  private closed = false;
  private generation = 0;
  private host: FlashHost | null = null;
  private pending: Promise<boolean> | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private failure: string | null = null;
  private readonly listeners = new Set<(enabled: boolean) => void>();
  constructor(options: Options) { this.options = options; }
  getFlashEnabled = () => this.active;
  isPreparing = () => this.pending !== null;
  subscribeFlashEnabled = (listener: (enabled: boolean) => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  async readiness(): Promise<FlashReadiness> {
    const result = await this.options.inspect();
    return result.ready && this.failure ? { ...result, detail: this.failure } : result;
  }
  async restore(): Promise<void> {
    if (this.options.preferences.getFlashEnabled()) await this.setFlashEnabled(true).catch(() => {});
  }
  setFlashEnabled(value: unknown): Promise<boolean> {
    const enabled = parseFlashEnabled(value);
    if (this.closed) return Promise.reject(new Error('Flash settings are closed.'));
    if (!enabled) {
      this.options.preferences.setFlashEnabled(false);
      this.generation++; this.pending = null; this.failure = null;
      this.publish(false); this.retire();
      return Promise.resolve(false);
    }
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    const operation = this.enable(generation);
    this.pending = operation;
    void operation.finally(() => { if (this.pending === operation) this.pending = null; }).catch(() => {});
    return operation;
  }
  private assertCurrent(generation: number) {
    if (this.closed || generation !== this.generation) throw new FlashError('canceled', 'Flash activation was canceled.');
  }
  private async enable(generation: number): Promise<boolean> {
    try {
      const status = await this.options.inspect();
      this.assertCurrent(generation);
      this.assertReady(status);
      await this.stopping;
      this.assertCurrent(generation);
      const host = this.host ??= this.options.createHost();
      await host.transaction(async () => {}, new AbortController().signal);
      this.assertCurrent(generation);
      this.options.preferences.setFlashEnabled(true);
      this.failure = null; this.publish(true);
      return true;
    } catch (error) {
      if (generation === this.generation && !this.closed) {
        this.failure = error instanceof FlashError ? error.message : 'Flash could not be prepared. Check its installation and try again.';
        this.publish(false); this.retire();
        this.options.preferences.setFlashEnabled(false);
      }
      throw error;
    }
  }
  private assertReady(status: FlashReadiness) {
    if (!status.ready) throw new FlashError('not_ready', status.detail);
  }
  private publish(value: boolean) {
    this.active = value;
    for (const listener of this.listeners) listener(value);
  }
  private retire() {
    const host = this.host; this.host = null;
    if (host) this.stopping = this.stopping.then(() => host.release());
    void this.stopping.catch(() => {});
  }
  async dispose() {
    this.closed = true; this.generation++; this.listeners.clear(); this.retire();
    await this.stopping;
  }
}
