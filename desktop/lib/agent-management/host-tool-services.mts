import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export interface HostServiceOptions {
  dependencyEnvironment?: { HOMIE_SERVICE_NODE: string; HOMIE_SERVICE_RUNTIME_DIR: string };
  key: string; owner: string; fingerprint: string;
  executable: string; script: string; sourceDirectory: string;
  files: readonly { path: string; content: string }[];
  valid(): boolean;
}
export interface HostServiceResult {
  ok: boolean;
  error?: { code: string; message: string };
}
interface Service {
  options: HostServiceOptions;
  owners: Map<string, () => boolean>;
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  queue: Promise<unknown>;
  pending?: { resolve(value: HostServiceResult): void; reject(error: Error): void };
  buffer: string;
  stopped: boolean;
}
function assertService(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Approved bundle scripts supervise their own service. No shell, RPC port or worker-selected commands. */
export class HostToolServices {
  private readonly directory: string;
  private readonly timeoutMs: number;
  private readonly entries = new Map<string, Promise<Service>>();
  private readonly live = new Set<Service>();
  private disposed = false;
  constructor(directory: string, timeoutMs = 25_000) { this.directory = directory; this.timeoutMs = timeoutMs; }

  private valid(service: Service) {
    try { return !this.disposed && [...service.owners.values()].every(check => check() === true); }
    catch { return false; }
  }
  private stop(service: Service, message: string, immediate = false) {
    const kill = (signal: NodeJS.Signals) => {
      if (!service.child.pid) return;
      try {
        if (process.platform === 'win32') service.child.kill(signal);
        else process.kill(-service.child.pid, signal);
      } catch { /* Already exited. Only our own process group is addressed. */ }
    };
    if (service.stopped) { if (immediate) kill('SIGKILL'); return; }
    service.stopped = true;
    service.pending?.reject(new Error(message)); service.pending = undefined;
    service.child.stdin.end();
    kill(immediate ? 'SIGKILL' : 'SIGTERM');
    if (!immediate) {
      const timer = setTimeout(() => kill('SIGKILL'), 1000);
      void service.closed.then(() => clearTimeout(timer));
    }
  }
  private async create(options: HostServiceOptions): Promise<Service> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.directory, 'service-'));
    try {
      for (const file of options.files) {
        const target = join(directory, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.content, { flag: 'wx', mode: 0o400 });
      }
      assertService(!this.disposed && options.valid(), 'Host service permission changed.');
      const child = spawn(options.executable, [join(directory, options.script)], {
        cwd: directory, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...options.dependencyEnvironment, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: userInfo().homedir, TMPDIR: tmpdir(),
          LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', HOMIE_SERVICE_SOURCE_DIR: options.sourceDirectory },
      });
      let closed!: () => void;
      const service: Service = { options, child, owners: new Map([[options.owner, options.valid]]),
        closed: new Promise<void>(resolve => { closed = resolve; }), queue: Promise.resolve(), buffer: '', stopped: false };
      this.live.add(service);
      const monitor = setInterval(() => {
        if (!this.valid(service)) this.stop(service, 'Host service permission changed.');
      }, 250);
      child.stderr.resume(); // Private server logs must not leak into tool results.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data: string) => {
        service.buffer += data;
        if (Buffer.byteLength(service.buffer) > 16_384) { this.stop(service, 'Host service response exceeded its limit.'); return; }
        const newline = service.buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const value = JSON.parse(service.buffer.slice(0, newline)) as HostServiceResult;
          service.buffer = service.buffer.slice(newline + 1);
          assertService(!!service.pending && !service.buffer.trim() && typeof value?.ok === 'boolean'
            && (value.ok !== false || (typeof value.error?.code === 'string' && typeof value.error?.message === 'string')),
          'Invalid host service response.');
          const pending = service.pending; service.pending = undefined;
          pending!.resolve(value);
        } catch { this.stop(service, 'Invalid host service response.'); }
      });
      child.on('error', () => this.stop(service, 'Host service executable could not start.'));
      child.stdin.on('error', () => this.stop(service, 'Host service input failed.'));
      child.once('close', () => {
        clearInterval(monitor);
        this.stop(service, 'Host service exited before completing the request.', true);
        this.live.delete(service);
        const entry = this.entries.get(options.key);
        if (entry) void entry.then(current => {
          if (current === service && this.entries.get(options.key) === entry) this.entries.delete(options.key);
        }).catch(() => {});
        closed();
        void rm(directory, { recursive: true, force: true }).catch(() => {});
      });
      return service;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async ensure(options: HostServiceOptions, signal: AbortSignal, inputs: Record<string, unknown> = {}): Promise<HostServiceResult> {
    signal.throwIfAborted();
    if (this.disposed || !options.valid()) throw new Error('Host service permission changed.');
    let entry = this.entries.get(options.key);
    if (!entry) {
      entry = this.create(options); this.entries.set(options.key, entry);
      void entry.catch(() => { if (this.entries.get(options.key) === entry) this.entries.delete(options.key); });
    }
    const service = await entry;
    if (service.options.fingerprint !== options.fingerprint || service.stopped) {
      this.stop(service, 'Host service definition changed.');
      await service.closed;
      if (this.entries.get(options.key) === entry) this.entries.delete(options.key);
      // Restart only on a new explicit request; never replay this request.
      throw new Error('Host service stopped or changed. Its previous request was not replayed.');
    }
    service.owners.set(options.owner, options.valid);
    const operation = service.queue.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      if (service.stopped || !this.valid(service)) throw new Error('Host service permission changed.');
      const abort = () => this.stop(service, 'Host service preparation canceled.');
      const timer = setTimeout(() => this.stop(service, 'Host service preparation timed out; no automatic retry.'), this.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await new Promise<HostServiceResult>((resolve, reject) => {
          service.pending = { resolve, reject };
          service.child.stdin.write(JSON.stringify({ action: 'ensure', inputs }) + '\n');
        });
        signal.throwIfAborted();
        assertService(!service.stopped && this.valid(service), 'Host service stopped or permission changed.');
        if (result.ok !== true) this.stop(service, 'Host service preparation failed.');
        return result;
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    });
    service.queue = operation;
    return operation;
  }
  stopOwner(owner: string) {
    for (const entry of this.entries.values()) void entry.then(service => {
      if (service.owners.has(owner)) this.stop(service, 'Host service approval revoked.');
    }).catch(() => {});
  }
  dispose() {
    this.disposed = true;
    for (const service of this.live) this.stop(service, 'Cheshi is closing.', true);
    for (const entry of this.entries.values()) void entry.then(service => this.stop(service, 'Cheshi is closing.', true)).catch(() => {});
  }
}
