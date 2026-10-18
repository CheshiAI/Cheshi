import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { hostPythonDistribution, type PythonDistribution } from './host-python-catalog.mts';

export interface ManagedPython { id: string; version: string; executable: string }
export interface HostPythonProvider {
  prepare(version?: string): Promise<ManagedPython>;
  matches(executable: string, id: string | undefined, version?: string): boolean;
  dispose(): void;
}
type Download = (url: string, options: RequestInit) => Promise<Response>;
const run = promisify(execFile);
const flights = new Map<string, Promise<ManagedPython>>();
const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' };

function assertRuntime(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function downloadUrl(value: string) {
  const url = new URL(value);
  assertRuntime(url.protocol === 'https:' && !url.username && !url.password && !url.port
    && ['github.com', 'release-assets.githubusercontent.com'].includes(url.hostname), 'Unexpected Python download destination.');
  return url.href;
}

/** Downloads only pinned publisher archives. Preparation never runs Homie code or grants access. */
export class HostPythonRuntime implements HostPythonProvider {
  private readonly directory: string;
  private readonly distribution: (version?: string) => PythonDistribution;
  private readonly download: Download;
  private readonly stopped = new AbortController();

  constructor(directory: string, options: { distribution?: (version?: string) => PythonDistribution; download?: Download } = {}) {
    this.directory = resolve(directory);
    this.distribution = options.distribution ?? hostPythonDistribution;
    this.download = options.download ?? ((url, options) => fetch(url, options));
  }
  matches(executable: string, id: string | undefined, version?: string) {
    try {
      const distribution = this.distribution(version);
      return id === distribution.id && executable === join(this.directory, distribution.id, distribution.executable);
    } catch { return false; }
  }
  async prepare(version?: string): Promise<ManagedPython> {
    this.stopped.signal.throwIfAborted();
    const distribution = this.distribution(version), target = join(this.directory, distribution.id);
    let pending = flights.get(target);
    if (!pending) {
      pending = this.install(distribution, target);
      flights.set(target, pending);
      void pending.finally(() => { if (flights.get(target) === pending) flights.delete(target); }).catch(() => {});
    }
    const result = await pending;
    this.stopped.signal.throwIfAborted();
    return result;
  }
  private async installed(distribution: PythonDistribution, target: string): Promise<ManagedPython | null> {
    let info;
    try { info = await lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    assertRuntime(info.isDirectory() && !info.isSymbolicLink(), 'Managed Python directory is invalid.');
    const receipt = JSON.parse(await readFile(join(target, 'cheshi-runtime.json'), 'utf8')) as Record<string, unknown>;
    const executable = join(target, distribution.executable), actual = await realpath(executable);
    assertRuntime(inside(target, actual) && actual === executable && receipt.id === distribution.id
      && receipt.archiveSha256 === distribution.sha256 && receipt.executableSha256 === await digest(actual),
    'Managed Python installation changed. Prepare a clean runtime before reviewing host access.');
    await access(actual, constants.X_OK);
    return { id: distribution.id, version: distribution.version, executable };
  }
  private async fetchArchive(distribution: PythonDistribution, archive: string, signal: AbortSignal) {
    let url = downloadUrl(distribution.url), response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await this.download(url, { redirect: 'manual', signal, credentials: 'omit' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      assertRuntime(location !== null, 'Python download redirect is missing its destination.');
      url = downloadUrl(new URL(location, url).href);
    }
    assertRuntime(response?.ok === true && response.body !== null, `Python download failed (HTTP ${response?.status ?? 'unknown'}). Check the network and try preparation again.`);
    const file = await open(archive, 'wx', 0o600), hash = createHash('sha256');
    const reader = response.body!.getReader();
    let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        assertRuntime(bytes <= distribution.bytes, 'Python download exceeds its expected size.');
        hash.update(chunk.value);
        await file.writeFile(chunk.value);
      }
      assertRuntime(bytes === distribution.bytes && hash.digest('hex') === distribution.sha256, 'Python download checksum or size does not match the pinned release.');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close(); }
  }
  private async install(distribution: PythonDistribution, target: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    assertRuntime(await realpath(this.directory) === this.directory, 'Managed Python storage must not be redirected by a symbolic link.');
    const existing = await this.installed(distribution, target);
    if (existing) return existing;
    const staging = await mkdtemp(join(this.directory, '.preparing-'));
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(180_000)]);
    try {
      const archive = join(staging, 'python.tar.gz');
      await this.fetchArchive(distribution, archive, signal);
      const { stdout } = await run('/usr/bin/tar', ['-tzf', archive], { signal, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: environment });
      const entries = stdout.trim().split('\n');
      assertRuntime(entries.length > 0 && entries.every(path => /^python\//.test(path) && !path.split('/').includes('..') && !path.includes('\\')),
        'Unexpected paths in the Python archive.');
      await run('/usr/bin/tar', ['-xzf', archive, '-C', staging], { signal, timeout: 30_000, maxBuffer: 1024 * 1024, env: environment });
      const executable = join(staging, distribution.executable);
      assertRuntime(await realpath(executable) === executable, 'Python executable must remain inside the managed installation.');
      const { stdout: probe } = await run(executable, ['-I', '-B', '-c',
        'import sys, json, ssl, sqlite3, ctypes; print(json.dumps({"version": ".".join(map(str, sys.version_info[:3]))}))'],
      { signal, timeout: 10_000, maxBuffer: 4096, env: environment });
      assertRuntime(JSON.parse(probe).version === distribution.version, 'Prepared Python version does not match the declared version.');
      await writeFile(join(staging, 'cheshi-runtime.json'), JSON.stringify({ id: distribution.id,
        archiveSha256: distribution.sha256, executableSha256: await digest(executable) }), { flag: 'wx', mode: 0o600 });
      await rm(archive);
      signal.throwIfAborted();
      try { await rename(staging, target); }
      catch (error) {
        // Another app process may have finished the same immutable installation.
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      const result = await this.installed(distribution, target);
      assertRuntime(result !== null, 'Python preparation did not publish a complete installation.');
      return result;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  dispose() { this.stopped.abort(); }
}
