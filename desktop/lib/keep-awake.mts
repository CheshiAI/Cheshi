import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import type { KeepAwakeState } from '../shared/keep-awake.ts';

interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  spawn?: typeof spawnChild;
  stopTimeoutMs?: number;
  startTimeoutMs?: number;
}

interface OwnedProcess {
  child: ChildProcess;
  spawned: boolean;
  stopping: boolean;
  finished: boolean;
  ready: Promise<string | null>;
  ended: Promise<void>;
}

function within<T>(promise: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), milliseconds);
    void promise.then(value => { clearTimeout(timer); resolve(value); });
  });
}

export function createKeepAwakeService(options: KeepAwakeOptions = {}) {
  const supported = (options.platform ?? process.platform) === 'darwin';
  const spawn = options.spawn ?? spawnChild;
  const stopTimeout = options.stopTimeoutMs ?? 1000;
  const startTimeout = options.startTimeoutMs ?? 3000;
  const listeners = new Set<(state: KeepAwakeState) => void>();
  let state: KeepAwakeState = { supported, enabled: false, error: null };
  let owned: OwnedProcess | null = null;
  let disposed = false;
  let serial: Promise<unknown> = Promise.resolve();

  const snapshot = (): KeepAwakeState => ({ ...state });
  function publish(enabled: boolean, error: string | null = null) {
    state = { supported, enabled, error };
    for (const listener of listeners) {
      try { listener(snapshot()); } catch { /* A closed renderer must not interrupt process cleanup. */ }
    }
  }

  async function stop(record: OwnedProcess) {
    record.stopping = true;
    try {
      if (!record.finished) record.child.kill('SIGTERM');
      if (!await within(record.ended.then(() => true), stopTimeout, false)) {
        record.child.kill('SIGKILL');
        if (!await within(record.ended.then(() => true), stopTimeout, false)) {
          publish(record.spawned, 'The keep-awake process did not stop. Try again.');
          return;
        }
      }
      publish(false);
    } catch (error) {
      publish(record.spawned && !record.finished, String(error));
    }
  }

  async function start() {
    let child: ChildProcess;
    try {
      child = spawn('/usr/bin/caffeinate', ['-d', '-i'], { stdio: 'ignore', shell: false });
    } catch (error) {
      publish(false, String(error));
      return;
    }
    let resolveReady!: (error: string | null) => void;
    let resolveEnded!: () => void;
    const record: OwnedProcess = {
      child, spawned: false, stopping: false, finished: false,
      ready: new Promise(resolve => { resolveReady = resolve; }),
      ended: new Promise(resolve => { resolveEnded = resolve; }),
    };
    owned = record;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (record.finished) return;
      record.finished = true;
      if (owned === record) owned = null;
      resolveReady('The keep-awake process exited before it started.');
      resolveEnded();
      publish(false, record.stopping ? null
        : `The keep-awake process exited unexpectedly (${signal ?? code ?? 'unknown'}).`);
    };
    child.once('spawn', () => {
      record.spawned = true;
      resolveReady(null);
    });
    child.on('error', (error: Error) => {
      resolveReady(error.message);
      if (!record.spawned) {
        record.finished = true;
        if (owned === record) owned = null;
        resolveEnded();
      }
      publish(record.spawned && !record.finished, error.message);
    });
    child.once('exit', finish);
    child.once('close', finish);
    const error = await within(record.ready, startTimeout, 'The keep-awake process did not start.');
    if (error) {
      if (!record.finished) await stop(record);
      publish(record.spawned && !record.finished, error);
    } else if (!record.finished) {
      publish(true);
    }
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = serial.then(operation);
    serial = result.catch(() => {});
    return result;
  }

  return {
    snapshot,
    setEnabled(enabled: unknown): Promise<KeepAwakeState> {
      if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('Expected a boolean keep-awake setting.'));
      return enqueue(async () => {
        if (disposed) throw new Error('The keep-awake service is closed.');
        if (!supported) publish(false, enabled ? 'Keep awake is available on macOS only.' : null);
        else if (enabled && !owned) await start();
        else if (!enabled && owned) await stop(owned);
        else if (!enabled) publish(false);
        return snapshot();
      });
    },
    subscribe(listener: (state: KeepAwakeState) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose(): Promise<void> {
      disposed = true;
      return enqueue(async () => {
        if (owned) await stop(owned);
        listeners.clear();
        if (owned && !owned.finished) throw new Error(state.error ?? 'The keep-awake process did not stop.');
      });
    },
  };
}
