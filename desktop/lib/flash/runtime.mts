import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { callFlash, FlashError, type FlashConnection } from './client.mts';

export interface FlashHost {
  transaction<T>(operation: (connection: FlashConnection) => Promise<T>, signal: AbortSignal): Promise<T>;
  release(): Promise<void>;
}
export interface FlashRuntimeOptions {
  directory: string;
  executable: string;
  modelCache?: string;
  device?: 'mps' | 'cpu';
  startupTimeoutMs?: number;
}
type Status = { state: string; capabilities?: string[] };

async function connection(directory: string): Promise<FlashConnection> {
  const file = await open(join(directory, 'admin.token'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 257 || (info.mode & 0o077) || info.uid !== process.getuid?.()) {
      throw new FlashError('unavailable', 'Unsafe Flash credential file');
    }
    const token = (await file.readFile('utf8')).trim();
    if (token.length < 32 || token.length > 256) throw new FlashError('unavailable', 'Invalid Flash credential file');
    return { socketPath: join(directory, 'flash.sock'), token };
  } finally { await file.close(); }
}

function assertCompatible(status: Status): void {
  if (!['source.ingest.v1', 'sources.list.v1', 'sessions.delete.v1'].every(capability => status.capabilities?.includes(capability))) {
    throw new FlashError('unavailable', 'Update the local Flash service to enable session ingestion');
  }
}

/** One model and one administrative writer per app data directory. Never kill an adopted service. */
export class FlashRuntime implements FlashHost {
  private readonly options: FlashRuntimeOptions;
  private child: ChildProcess | null = null;
  private starting: Promise<FlashConnection> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly lifetime = new AbortController();
  constructor(options: FlashRuntimeOptions) { this.options = options; }

  private async ready(): Promise<FlashConnection> {
    this.lifetime.signal.throwIfAborted();
    if (this.starting) return this.starting;
    const start = this.start();
    this.starting = start;
    try { return await start; } finally { if (this.starting === start) this.starting = null; }
  }

  private async start(): Promise<FlashConnection> {
    const { directory } = this.options;
    let adopted = false;
    // An already running instance can be shared without taking ownership of its process.
    try {
      const existing = await connection(directory);
      const status = await callFlash<Status>({ ...existing, timeoutMs: 1500 }, 'status', {}, this.lifetime.signal);
      if (status.state === 'ready') { assertCompatible(status); return existing; }
      if (status.state === 'unavailable') throw new FlashError('not_ready', 'Flash model initialization failed');
      adopted = status.state === 'loading';
    } catch (error) {
      if (error instanceof FlashError && /Update|initialization/.test(error.message)) throw error;
    }
    this.lifetime.signal.throwIfAborted();
    if (!this.child && !adopted) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      this.lifetime.signal.throwIfAborted();
      const args = ['--data-dir', directory, 'serve', '--device', this.options.device ?? (process.platform === 'darwin' ? 'mps' : 'cpu')];
      if (this.options.modelCache) args.push('--model-cache', this.options.modelCache);
      const child = spawn(this.options.executable, args, { stdio: 'ignore', shell: false,
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
      this.child = child;
      child.once('exit', () => { if (this.child === child) this.child = null; });
      child.once('error', () => { if (this.child === child) this.child = null; });
    }
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      await delay(200, undefined, { signal: this.lifetime.signal });
      if (!this.child && !adopted) throw new FlashError('not_ready', 'Flash did not start. Check the installed executable and offline model cache.');
      try {
        const candidate = await connection(directory);
        const status = await callFlash<Status>({ ...candidate, timeoutMs: 1500 }, 'status', {}, this.lifetime.signal);
        if (status.state === 'ready') { assertCompatible(status); return candidate; }
        if (status.state === 'unavailable') throw new FlashError('not_ready', 'Flash model initialization failed');
      } catch (error) {
        if (error instanceof FlashError && /Update|initialization/.test(error.message)) throw error;
      }
    }
    throw new FlashError('not_ready', 'Flash is still loading. Retry later.');
  }

  transaction<T>(operation: (connection: FlashConnection) => Promise<T>, signal: AbortSignal): Promise<T> {
    const result = this.tail.then(async () => {
      signal.throwIfAborted();
      const client = await this.ready();
      signal.throwIfAborted();
      return operation(client);
    });
    this.tail = result.catch(() => {});
    return result;
  }

  async release(): Promise<void> {
    this.lifetime.abort();
    await this.starting?.catch(() => {});
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.once('error', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await this.tail;
  }
}

const runtimes = new Map<string, { runtime: FlashRuntime; users: number }>();
export function acquireFlashHost(userData: string): FlashHost {
  const directory = join(userData, 'flash');
  let entry = runtimes.get(directory);
  if (!entry) {
    // Development fallback only. Packaged installation is explicitly configured by its host.
    const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    entry = { users: 0, runtime: new FlashRuntime({ directory,
      executable: process.env.CHESHI_FLASH_EXECUTABLE?.trim() || join(dirname(checkout), 'cheshi-flash/.venv/bin/cheshi-flash'),
      modelCache: process.env.CHESHI_FLASH_MODEL_CACHE?.trim()
        || join(homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'CheshiFlash/hub') }) };
    runtimes.set(directory, entry);
  }
  entry.users++;
  const current = entry;
  let released = false;
  return { transaction: (operation, signal) => current.runtime.transaction(operation, signal), release: async () => {
    if (released) return;
    released = true;
    if (--current.users === 0) { runtimes.delete(directory); await current.runtime.release(); }
  } };
}
