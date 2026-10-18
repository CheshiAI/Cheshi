import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseHostDependencyLock } from '../../shared/host-dependencies.ts';
import { assertPrepared, fileHash, HostNodeRuntime, type HostNodeProvider, type ManagedNode } from './host-node-runtime.mts';

const run = promisify(execFile);
export interface ManagedHostDependencies { node: string; directory: string; id: string }
export interface HostDependencyProvider {
  prepare(lock: string, signal: AbortSignal, progress: (message: string) => void): Promise<ManagedHostDependencies>;
  check(lock: string, prepared: ManagedHostDependencies): Promise<boolean>;
}
const lockHash = (lock: string) => createHash('sha256').update(lock).digest('hex');

async function treeHash(root: string) {
  const hash = createHash('sha256');
  async function walk(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      // Appium and other services keep generated extension caches here, outside package source.
      if (path === root && entry.name === '.cache') continue;
      const file = join(path, entry.name), name = relative(root, file);
      hash.update(name + '\0');
      if (entry.isDirectory()) await walk(file);
      else if (entry.isSymbolicLink()) {
        const target = await readlink(file), rel = relative(root, resolve(dirname(file), target));
        assertPrepared(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'), 'Managed package link escapes its installation.');
        hash.update(`link:${target}\0`);
      } else {
        assertPrepared(entry.isFile(), 'Unexpected managed package file.');
        hash.update(await fileHash(file));
      }
    }
  }
  await walk(root);
  return hash.digest('hex');
}

/** Runs only after local host approval; npm lifecycle scripts are always disabled. */
export class HostServiceDependencies implements HostDependencyProvider {
  private readonly directory: string;
  private readonly node: HostNodeProvider;
  private readonly flights = new Map<string, Promise<ManagedHostDependencies>>();
  constructor(directory: string, node?: HostNodeProvider) {
    this.directory = resolve(directory);
    this.node = node ?? new HostNodeRuntime(join(this.directory, 'node'));
  }
  async check(lock: string, prepared: ManagedHostDependencies): Promise<boolean> {
    try {
      parseHostDependencyLock(lock);
      const target = join(this.directory, 'packages', prepared.id);
      if (target !== prepared.directory || await realpath(target) !== target) return false;
      const receipt = JSON.parse(await readFile(join(target, 'receipt.json'), 'utf8'));
      return receipt.lock === lockHash(lock) && receipt.node === prepared.node
        && receipt.nodeHash === await fileHash(prepared.node)
        && receipt.tree === await treeHash(join(target, 'node_modules'));
    } catch { return false; }
  }
  async prepare(lock: string, signal: AbortSignal, progress: (message: string) => void): Promise<ManagedHostDependencies> {
    const manifest = parseHostDependencyLock(lock), key = lockHash(lock);
    const active = this.flights.get(key);
    if (active) {
      await active.catch(() => {});
      signal.throwIfAborted();
      return this.prepare(lock, signal, progress);
    }
    const pending = this.install(lock, manifest, signal, progress);
    this.flights.set(key, pending);
    try { return await pending; }
    finally { if (this.flights.get(key) === pending) this.flights.delete(key); }
  }
  private async install(lock: string, manifest: ReturnType<typeof parseHostDependencyLock>, signal: AbortSignal, progress: (message: string) => void) {
    signal.throwIfAborted(); progress('Preparing managed Node…');
    const node = await this.node.prepare(signal);
    const id = `${node.id}-${lockHash(lock).slice(0, 32)}`;
    const parent = join(this.directory, 'packages'), target = join(parent, id);
    const result = { id, node: node.executable, directory: target };
    await mkdir(parent, { recursive: true, mode: 0o700 });
    assertPrepared(await realpath(parent) === parent, 'Managed dependency storage must not be a symbolic link.');
    progress('Checking managed dependencies…');
    if (await this.check(lock, result)) { progress('Dependencies ready.'); return result; }
    let existing = false;
    try { await lstat(target); existing = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Do not overwrite a runtime that a running service might still be using.
    assertPrepared(!existing, `Managed dependencies are damaged: ${target}. Stop the service and remove this installation before preparing it again.`);
    const stage = await mkdtemp(join(parent, '.preparing-'));
    try {
      await writeFile(join(stage, 'package.json'), JSON.stringify(manifest), { mode: 0o600 });
      await writeFile(join(stage, 'package-lock.json'), lock, { mode: 0o600 });
      progress('Downloading and installing declared dependencies…');
      await this.installPackages(node, stage, signal);
      progress('Verifying installed dependencies…');
      await writeFile(join(stage, 'receipt.json'), JSON.stringify({ lock: lockHash(lock), node: node.executable,
        nodeHash: await fileHash(node.executable), tree: await treeHash(join(stage, 'node_modules')) }), { mode: 0o600 });
      signal.throwIfAborted();
      try { await rename(stage, target); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      assertPrepared(await this.check(lock, result), 'Dependency preparation did not publish a valid installation.');
      progress('Dependencies ready.');
      return result;
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  private async installPackages(node: ManagedNode, cwd: string, signal: AbortSignal) {
    try {
      await run(node.executable, [node.npm, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
        '--registry=https://registry.npmjs.org', `--userconfig=${join(cwd, 'empty.npmrc')}`, '--globalconfig=/dev/null'], {
        cwd, signal, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
        env: { PATH: `${dirname(node.executable)}:/usr/bin:/bin`, HOME: cwd, LANG: 'en_US.UTF-8',
          npm_config_cache: join(this.directory, 'npm-cache'), npm_config_fetch_retries: '1', npm_config_fetch_timeout: '60000' },
      });
    } catch (cause) {
      signal.throwIfAborted();
      throw new Error('Managed dependency installation failed. Check the network and free disk space, then retry host preparation. No device action ran.', { cause });
    }
  }
}
