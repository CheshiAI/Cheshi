import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = 'https://github.com/open-pencil/open-pencil';
const maximumArchiveBytes = 64 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface SourcePin { commit: string; version: string; source: string; archiveSha256: string; treeSha256: string }

function parsePin(value: unknown): SourcePin {
  const pin = value as Partial<SourcePin> & { repository?: unknown; localPatches?: unknown } | null;
  if (!pin || pin.repository !== repository || typeof pin.commit !== 'string' || !/^[a-f0-9]{40}$/.test(pin.commit)
    || typeof pin.version !== 'string' || !pin.version
    || pin.source !== `https://codeload.github.com/open-pencil/open-pencil/tar.gz/${pin.commit}`
    || typeof pin.archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pin.archiveSha256)
    || typeof pin.treeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pin.treeSha256)
    || !Array.isArray(pin.localPatches) || pin.localPatches.length !== 0) {
    throw new Error('Invalid OpenPencil source pin. Use an official fixed commit, both SHA-256 checksums and no local patches.');
  }
  return { commit: pin.commit, version: pin.version, source: pin.source,
    archiveSha256: pin.archiveSha256, treeSha256: pin.treeSha256 };
}

async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Sorted POSIX paths, NUL, file SHA-256 and LF; independent of timestamps and platform. */
export async function openPencilTreeHash(directory: string): Promise<string> {
  const files: string[] = [];
  async function visit(relative: string) {
    const filename = path.join(directory, relative);
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw new Error('OpenPencil source must not contain symbolic links. Existing files were retained.');
    if (info.isDirectory()) {
      for (const name of await readdir(filename)) await visit(relative ? `${relative}/${name}` : name);
    } else if (info.isFile()) files.push(relative);
    else throw new Error('OpenPencil source contains an unsupported filesystem entry.');
  }
  await visit('');
  const hash = createHash('sha256');
  for (const relative of files.sort()) hash.update(`${relative}\0${digest(await readFile(path.join(directory, relative)))}\n`);
  return hash.digest('hex');
}

function assertMatchingTree(actual: string, pin: SourcePin): void {
  if (actual !== pin.treeSha256) {
    throw new Error('OpenPencil source differs from the pinned version. Existing files were retained. Move vendor/open-pencil aside before preparing a clean copy.');
  }
}

async function verifyTree(directory: string, pin: SourcePin) {
  assertMatchingTree(await openPencilTreeHash(directory), pin);
  const metadata: unknown = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || metadata.version !== pin.version) {
    throw new Error('OpenPencil package version does not match its source pin.');
  }
}

async function downloadArchive(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`OpenPencil source download failed (HTTP ${response.status}).`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assertArchiveSize(size);
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function assertArchiveSize(size: number) {
  if (size > maximumArchiveBytes) throw new Error('OpenPencil source archive exceeds 64 MiB.');
}

function assertArchive(bytes: Uint8Array, pin: SourcePin) {
  assertArchiveSize(bytes.byteLength);
  if (digest(bytes) !== pin.archiveSha256) throw new Error('OpenPencil archive checksum mismatch. No source files were installed.');
}

function assertArchivePaths(list: string, commit: string) {
  const prefix = `open-pencil-${commit}`;
  const entries = list.trimEnd().split('\n');
  if (!entries.length || entries.some(name => {
    const parts = name.replace(/\/$/, '').split('/');
    return parts[0] !== prefix || parts.some(part => !part || part === '.' || part === '..') || /[\\\0\r:]/.test(name);
  })) throw new Error('OpenPencil archive contains an unexpected path.');
}

/** Import-safe preparation; never replaces a modified or partially populated source directory. */
export async function prepareOpenPencilSource(root: string, options: {
  download?: (url: string) => Promise<Uint8Array>;
} = {}): Promise<{ directory: string; commit: string; reused: boolean }> {
  const vendor = path.join(root, 'vendor');
  const pin = parsePin(JSON.parse(await readFile(path.join(vendor, 'open-pencil.version.json'), 'utf8')));
  const directory = path.join(vendor, 'open-pencil');
  const vendorInfo = await lstat(vendor);
  if (!vendorInfo.isDirectory() || vendorInfo.isSymbolicLink()) throw new Error('The vendor directory must be a regular local directory.');
  if (await exists(directory)) {
    await verifyTree(directory, pin);
    return { directory, commit: pin.commit, reused: true };
  }
  const staging = await mkdtemp(path.join(vendor, '.open-pencil-'));
  try {
    const bytes = await (options.download ?? downloadArchive)(pin.source);
    assertArchive(bytes, pin);
    const archive = path.join(staging, 'source.tar.gz');
    await writeFile(archive, bytes, { flag: 'wx' });
    const { stdout } = await execute('tar', ['-tzf', archive], { maxBuffer: 4 * 1024 * 1024 });
    assertArchivePaths(stdout, pin.commit);
    const extracted = path.join(staging, 'source');
    await mkdir(extracted);
    await execute('tar', ['-xzf', archive, '--strip-components=1', '--no-same-owner', '-C', extracted]);
    await verifyTree(extracted, pin);
    // A concurrent preparer may finish first. Verify its result without replacing it.
    if (await exists(directory)) {
      await verifyTree(directory, pin);
      return { directory, commit: pin.commit, reused: true };
    }
    try { await rename(extracted, directory); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await verifyTree(directory, pin);
      return { directory, commit: pin.commit, reused: true };
    }
    return { directory, commit: pin.commit, reused: false };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
