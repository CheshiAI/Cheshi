import { spawn, type ChildProcess } from 'node:child_process';
import type { KeepAwakeState } from '../shared/keep-awake.ts';

interface KeepAwakeOptions {
  platform?: string;
  spawn?: typeof spawn;
  stopTimeoutMs?: number;
}

interface OwnedProcess {
  child: ChildProcess;
  started: boolean;
  stopping: boolean;
}

export class KeepAwakeService {
  private readonly options: KeepAwakeOptions;
  private readonly state: KeepAwakeState;
  private readonly listeners = new Set<(state: KeepAwakeState) => void>();
  private owned: OwnedProcess | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: KeepAwakeOptions = {}) {
    this.options = options;
    this.state = { supported: (options.platform ?? process.platform) === 'darwin', enabled: false,
      busy: false, error: null, revision: 0 };
  }

  snapshot(): KeepAwakeState { return { ...this.state }; }

  subscribe(listener: (state: KeepAwakeState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setEnabled(enabled: unknown): Promise<KeepAwakeState> {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Keep awake requires a boolean.'));
    if (this.disposed) return Promise.reject(new Error('Keep awake is shutting down.'));
    const operation = this.queue.then(() => this.apply(enabled));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    try {
      await this.queue;
      await this.apply(false);
      this.listeners.clear();
    } catch (error) {
      this.disposed = false;
      throw error;
    }
  }

  private publish(): void {
    this.state.revision += 1;
    for (const listener of this.listeners) listener(this.snapshot());
  }

  private async apply(enabled: boolean): Promise<KeepAwakeState> {
    if (!this.state.supported) {
      if (enabled) throw new Error('Keep awake is available on macOS only.');
      return this.snapshot();
    }
    if (enabled === this.state.enabled && !this.owned?.stopping) return this.snapshot();
    this.state.busy = true;
    this.state.error = null;
    this.publish();
    try {
      if (enabled) await this.start();
      else if (this.owned) await this.stop(this.owned);
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.state.busy = false;
      this.publish();
    }
    return this.snapshot();
  }

  private start(): Promise<void> {
    const child = (this.options.spawn ?? spawn)('/usr/bin/caffeinate', ['-d', '-i'], { stdio: 'ignore' });
    const owned: OwnedProcess = { child, started: false, stopping: false };
    this.owned = owned;
    return new Promise((resolve, reject) => {
      child.once('spawn', () => {
        if (this.owned !== owned) return;
        owned.started = true;
        this.state.enabled = true;
        resolve();
      });
      child.on('error', error => {
        if (this.owned !== owned) return;
        if (!owned.started) {
          this.owned = undefined;
          reject(error);
        } else {
          this.state.error = error.message;
          this.publish();
        }
      });
      child.once('exit', (code, signal) => {
        if (this.owned !== owned) return;
        this.owned = undefined;
        this.state.enabled = false;
        if (!owned.started) reject(new Error('Keep awake exited before starting.'));
        else if (!owned.stopping) this.state.error = `Keep awake exited unexpectedly (${signal ?? code ?? 'unknown'}).`;
        this.publish();
      });
    });
  }

  private stop(owned: OwnedProcess): Promise<void> {
    owned.stopping = true;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        owned.child.removeListener('exit', exited);
        if (error) { owned.stopping = false; reject(error); }
        else resolve();
      };
      const exited = () => finish();
      owned.child.once('exit', exited);
      timer = setTimeout(() => {
        timer = setTimeout(() => finish(new Error('Could not confirm that keep awake stopped.')), this.options.stopTimeoutMs ?? 2000);
        try { owned.child.kill('SIGKILL'); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }, this.options.stopTimeoutMs ?? 2000);
      try { owned.child.kill('SIGTERM'); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
