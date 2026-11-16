import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const HOST_NODE_VERSION = '24.22.0';
// Official https://nodejs.org/dist/v24.22.0/SHASUMS256.txt; never resolve latest at runtime.
const checksums = {
  arm64: '6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5',
  x64: '495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91',
};
export interface ManagedNode { executable: string; npm: string; id: string }
export interface HostNodeProvider { prepare(signal: AbortSignal): Promise<ManagedNode> }
type Download = (url: string, options: RequestInit) => Promise<Response>;
export function assertPrepared(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export async function fileHash(path: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

/** Private pinned Node distribution. Never uses a terminal PATH or system package manager. */
export class HostNodeRuntime implements HostNodeProvider {
  private readonly directory: string;
  private readonly download: Download;
  constructor(directory: string, download: Download = (url, options) => fetch(url, options)) { this.directory = resolve(directory); this.download = download; }
  async prepare(signal: AbortSignal): Promise<ManagedNode> {
    assertPrepared(process.platform === 'darwin' && process.arch in checksums, 'Managed host Node requires macOS arm64 or x64.');
    const archiveHash = checksums[process.arch as keyof typeof checksums];
    const name = `node-v${HOST_NODE_VERSION}-darwin-${process.arch}`, id = `${name}-${archiveHash.slice(0, 16)}`;
    const target = join(this.directory, id);
    const installed = async () => {
      let info;
      try { info = await lstat(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      assertPrepared(info.isDirectory() && !info.isSymbolicLink(), 'Managed Node directory is invalid.');
      const executable = join(target, name, 'bin/node'), npm = join(target, name, 'lib/node_modules/npm/bin/npm-cli.js');
      const receipt = JSON.parse(await readFile(join(target, 'receipt.json'), 'utf8'));
      assertPrepared(await realpath(executable) === executable && await realpath(npm) === npm
        && receipt.archiveHash === archiveHash && receipt.executableHash === await fileHash(executable),
      'Managed Node changed. Remove the damaged managed installation and prepare host access again.');
      return { executable, npm, id };
    };
    const existing = await installed();
    if (existing) return existing;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    assertPrepared(await realpath(this.directory) === this.directory, 'Managed Node storage must not be a symbolic link.');
    const stage = await mkdtemp(join(this.directory, '.preparing-'));
    try {
      const response = await this.download(`https://nodejs.org/dist/v${HOST_NODE_VERSION}/${name}.tar.gz`,
        { signal, redirect: 'error', credentials: 'omit' });
      assertPrepared(response.ok && response.body !== null, `Node download failed (HTTP ${response.status}). Check the network and retry host preparation.`);
      const archive = join(stage, 'node.tar.gz'), file = await open(archive, 'wx', 0o600);
      const reader = response.body!.getReader(), hash = createHash('sha256');
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          assertPrepared(size <= 100 * 1024 * 1024, 'Node download exceeds its size limit.');
          hash.update(chunk.value); await file.writeFile(chunk.value);
        }
        assertPrepared(hash.digest('hex') === archiveHash, 'Node download checksum does not match the pinned release.');
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close(); }
      const options = { signal, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 };
      const { stdout } = await run('/usr/bin/tar', ['-tzf', archive], options);
      assertPrepared(stdout.trim().split('\n').every(path => path.startsWith(`${name}/`) && !path.split('/').includes('..') && !path.includes('\\')),
        'Unexpected paths in Node archive.');
      await run('/usr/bin/tar', ['-xzf', archive, '-C', stage], options);
      const executable = join(stage, name, 'bin/node');
      const probe = await run(executable, ['--version'], { signal, timeout: 10_000 });
      assertPrepared(probe.stdout.trim() === `v${HOST_NODE_VERSION}`, 'Prepared Node version does not match the pinned release.');
      await writeFile(join(stage, 'receipt.json'), JSON.stringify({ archiveHash, executableHash: await fileHash(executable) }), { mode: 0o600 });
      await rm(archive); signal.throwIfAborted();
      try { await rename(stage, target); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      const result = await installed();
      assertPrepared(result !== null, 'Node preparation did not publish a complete installation.');
      return result;
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}
