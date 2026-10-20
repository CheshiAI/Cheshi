import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface BuildStamp { version: 1; input: string; outputs: Record<string, string> }
interface BuildOptions {
  root: string;
  output: string;
  inputs: string[];
  toolchain: string;
  force?: boolean;
  prepare?(): Promise<void>;
  build(directory: string): Promise<void>;
}
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function filesUnder(directory: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(relative: string) {
    const filename = path.join(directory, relative);
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw new Error(`Unexpected symbolic link in build inputs or outputs: ${filename}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(filename)).sort()) await visit(path.join(relative, name));
    } else if (info.isFile()) result.push(relative);
    else throw new Error(`Unsupported build entry: ${filename}`);
  }
  await visit('');
  return result;
}

async function fingerprint(options: BuildOptions): Promise<string> {
  const hash = createHash('sha256').update(options.toolchain);
  for (const input of [...options.inputs].sort()) {
    const filename = path.resolve(options.root, input);
    hash.update(`\0${input}\0`);
    if (!await exists(filename)) { hash.update('missing'); continue; }
    const info = await lstat(filename);
    const files = info.isDirectory() ? await filesUnder(filename) : [''];
    for (const file of files) hash.update(`${file}\0${digest(await readFile(file ? path.join(filename, file) : filename))}\n`);
  }
  return hash.digest('hex');
}

async function outputHashes(directory: string): Promise<Record<string, string>> {
  const outputs: Record<string, string> = {};
  for (const name of await filesUnder(directory)) outputs[name] = digest(await readFile(path.join(directory, name)));
  return outputs;
}

function isStamp(value: unknown): value is BuildStamp {
  if (!value || typeof value !== 'object') return false;
  const stamp = value as Partial<BuildStamp>;
  return stamp.version === 1 && typeof stamp.input === 'string' && !!stamp.outputs
    && typeof stamp.outputs === 'object' && !Array.isArray(stamp.outputs)
    && Object.hasOwn(stamp.outputs, 'index.html')
    && Object.entries(stamp.outputs).every(([name, hash]) => name !== '' && !path.isAbsolute(name)
      && !name.split(/[\\/]/).includes('..') && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
}

async function currentOutput(output: string, stampPath: string, input: string): Promise<boolean> {
  try {
    const saved: unknown = JSON.parse(await readFile(stampPath, 'utf8'));
    if (!isStamp(saved) || saved.input !== input) return false;
    const actual = await outputHashes(output);
    return Object.keys(actual).length === Object.keys(saved.outputs).length
      && Object.entries(actual).every(([name, hash]) => saved.outputs[name] === hash);
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

async function retainHashedAssets(output: string, staging: string, stampPath: string, outputs: Record<string, string>): Promise<void> {
  let saved: unknown;
  try { saved = JSON.parse(await readFile(stampPath, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!isStamp(saved) || !await exists(output)) return;
  // Open documents keep their original module graph, including lazy panels and
  // workers, across rebuilds. Only retain previously recorded, unmodified assets.
  const actual = await outputHashes(output);
  for (const [name, hash] of Object.entries(saved.outputs)) {
    if (!/^assets\/[^/\\]+-[\w-]{8,}\.[a-z0-9.]+$/u.test(name) || actual[name] !== hash) continue;
    if (Object.hasOwn(outputs, name)) {
      assertImmutableAsset(name, hash, outputs[name]!);
      continue;
    }
    const contents = await readFile(path.join(output, name));
    if (digest(contents) !== hash) continue;
    const target = path.join(staging, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
    outputs[name] = hash;
  }
}

function assertImmutableAsset(name: string, previous: string, next: string): void {
  if (previous !== next) throw new Error(`Editor asset changed without a new hash: ${name}`);
}

async function acquireLock(filename: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 180_000;
  while (true) {
    try {
      const handle = await open(filename, 'wx');
      try { await handle.writeFile(String(process.pid)); }
      finally { await handle.close(); }
      return () => rm(filename, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // Only one contender may inspect/remove a dead owner's lock. Re-read its
    // owner inside this guard so another contender cannot remove a new lock.
    const recovery = `${filename}.recovery`;
    let recovering = false;
    try {
      await mkdir(recovery);
      recovering = true;
      const owner = Number(await readFile(filename, 'utf8'));
      let abandoned = false;
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); }
        catch (error) { abandoned = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      } else abandoned = Date.now() - (await stat(filename)).mtimeMs > 180_000;
      if (abandoned) { await rm(filename, { force: true }); continue; }
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    } finally { if (recovering) await rm(recovery, { recursive: true, force: true }); }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the OpenPencil build lock: ${filename}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function assertBuildComplete(outputs: Record<string, string>) {
  if (!Object.hasOwn(outputs, 'index.html')) throw new Error('Editor build did not produce index.html.');
}

function assertInputsUnchanged(before: string, after: string) {
  if (before !== after) throw new Error('Editor build inputs changed during compilation. Run the build again.');
}

/** Serialize builders, validate every output, and publish only successful compilations. */
export async function buildCachedEditor(options: BuildOptions): Promise<{ reused: boolean }> {
  const cache = path.join(options.root, 'node_modules/.cache/cheshi-open-pencil');
  await mkdir(cache, { recursive: true });
  const release = await acquireLock(path.join(cache, 'build.lock'));
  const stampPath = path.join(cache, 'build.json');
  const backup = path.join(cache, 'previous');
  try {
    // Restore the previous bundle even if preparation or the next build fails.
    if (!await exists(options.output) && await exists(backup)) await rename(backup, options.output);
    await options.prepare?.();
    const input = await fingerprint(options);
    if (options.force !== true && await currentOutput(options.output, stampPath, input)) return { reused: true };
    const staging = await mkdtemp(path.join(cache, 'staging-'));
    try {
      await options.build(staging);
      const outputs = await outputHashes(staging);
      assertBuildComplete(outputs);
      await retainHashedAssets(options.output, staging, stampPath, outputs);
      assertInputsUnchanged(input, await fingerprint(options));
      await mkdir(path.dirname(options.output), { recursive: true });
      await rm(backup, { recursive: true, force: true });
      const hadOutput = await exists(options.output);
      if (hadOutput) await rename(options.output, backup);
      try { await rename(staging, options.output); }
      catch (error) { if (hadOutput) await rename(backup, options.output); throw error; }
      const stamp: BuildStamp = { version: 1, input, outputs };
      const nextStamp = path.join(cache, 'build.next.json');
      await writeFile(nextStamp, JSON.stringify(stamp));
      await rename(nextStamp, stampPath);
      await rm(backup, { recursive: true, force: true });
      return { reused: false };
    } finally { await rm(staging, { recursive: true, force: true }); }
  } finally { await release(); }
}
