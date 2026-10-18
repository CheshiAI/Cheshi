import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runFlashCommand } from './model-download.mts';

export interface FlashPluginManifest {
  schema: 1; id: 'cheshi-flash'; version: string; platform: 'darwin'; arch: 'arm64';
  hostApi: 1; protocol: 1; executable: 'bin/cheshi-flash'; python: 'python/bin/python3';
  model: string; modelRevision: string;
}
export interface FlashPluginRelease extends FlashPluginManifest { archive: { file: string; bytes: number; sha256: string } }
export const PLUGIN_HOST_API = 1;
export class FlashPluginError extends Error {}
export function assertPlugin(value: unknown, message: string): asserts value { if (!value) throw new FlashPluginError(message); }
export function isPluginVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value);
}
export function newerPlugin(a: string, b: string) {
  const first = a.split('.').map(Number), second = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (first[i] !== second[i]) return first[i]! > second[i]!; }
  return false;
}
export function parsePluginManifest(value: unknown): FlashPluginManifest {
  const item = value as Partial<FlashPluginManifest> | null;
  assertPlugin(item && item.schema === 1 && item.id === 'cheshi-flash' && isPluginVersion(item.version)
    && item.platform === 'darwin' && item.arch === 'arm64' && item.hostApi === PLUGIN_HOST_API && item.protocol === 1
    && item.executable === 'bin/cheshi-flash' && item.python === 'python/bin/python3'
    && typeof item.model === 'string' && /^[\w.-]+\/[\w.-]+$/.test(item.model)
    && typeof item.modelRevision === 'string' && /^[a-f0-9]{40}$/.test(item.modelRevision), 'Unsupported Flash plugin manifest or compatibility version.');
  return { schema: 1, id: 'cheshi-flash', version: item.version, platform: item.platform, arch: item.arch,
    hostApi: 1, protocol: 1, executable: item.executable, python: item.python, model: item.model, modelRevision: item.modelRevision };
}
export function parsePluginRelease(value: unknown): FlashPluginRelease {
  const manifest = parsePluginManifest(value);
  const archive = (value as { archive?: FlashPluginRelease['archive'] }).archive;
  assertPlugin(archive && archive.file === `cheshi-flash-${manifest.version}-darwin-arm64.tar.gz`
    && Number.isSafeInteger(archive.bytes) && archive.bytes > 0 && archive.bytes <= 4 * 1024 ** 3
    && typeof archive.sha256 === 'string' && /^[a-f0-9]{64}$/.test(archive.sha256), 'Invalid Flash plugin archive metadata.');
  return { ...manifest, archive: { file: archive.file, bytes: archive.bytes, sha256: archive.sha256 } };
}
export const pluginRoot = (userData: string) => join(userData, 'plugins', 'flash');
export const pluginVersionPath = (userData: string, version: string) => {
  assertPlugin(isPluginVersion(version), 'Invalid Flash version.');
  return join(pluginRoot(userData), 'versions', version);
};
export function pluginSelection(userData: string): { exists: boolean; version: string | null } {
  const file = join(pluginRoot(userData), 'current.json');
  if (!existsSync(file)) return { exists: false, version: null };
  const state = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
  assertPlugin(state.version === null || isPluginVersion(state.version), 'Invalid installed Flash plugin selection.');
  return { exists: true, version: state.version };
}
export async function selectPlugin(userData: string, version: string | null) {
  assertPlugin(version === null || isPluginVersion(version), 'Invalid Flash plugin selection.');
  const root = pluginRoot(userData);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.current-${randomUUID()}.json`);
  try {
    await writeFile(temporary, JSON.stringify({ version }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(root, 'current.json'));
  } finally { await rm(temporary, { force: true }); }
}
export async function pluginDigest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export type PluginFetch = (url: string, init: RequestInit) => Promise<Response>;
async function fetchReleaseFile(url: string, signal: AbortSignal, download: PluginFetch) {
  const origin = new URL(url).origin;
  for (let i = 0; i <= 5; i++) {
    const parsed = new URL(url);
    assertPlugin(parsed.protocol === 'https:' && !parsed.username && !parsed.password
      && (parsed.origin === origin || ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)), 'Unexpected Flash release destination.');
    const response = await download(url, { signal, redirect: 'manual', credentials: 'omit' });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      assertPlugin(response.ok, `Flash release is unavailable (HTTP ${response.status}). Configure an accessible release or a local manifest.`);
      return response;
    }
    const next = response.headers.get('location'); await response.body?.cancel();
    assertPlugin(next, 'Missing Flash release redirect.'); url = new URL(next, url).href;
  }
  throw new Error('Too many Flash release redirects.');
}
export function defaultPluginSource() {
  return process.env.CHESHI_FLASH_RELEASE_MANIFEST?.trim()
    || 'https://github.com/CheshiAI/Cheshi-flash/releases/latest/download/cheshi-flash-darwin-arm64.json';
}
export async function loadPluginRelease(source: string, signal: AbortSignal, download: PluginFetch = fetch) {
  let text: string;
  if (isAbsolute(source)) {
    const size = (await lstat(source)).size;
    assertPlugin(size <= 64 * 1024, 'Flash release manifest is too large.');
    text = await readFile(source, 'utf8');
  } else {
    const response = await fetchReleaseFile(source, signal, download);
    assertPlugin(response.body, 'Empty Flash release manifest.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const value = await reader.read(); if (value.done) break;
        size += value.value.length; assertPlugin(size <= 64 * 1024, 'Flash release manifest is too large.'); chunks.push(value.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    text = Buffer.concat(chunks).toString('utf8');
  }
  return parsePluginRelease(JSON.parse(text));
}
export async function downloadPlugin(source: string, release: FlashPluginRelease, target: string, signal: AbortSignal,
  progress: (received: number, total: number) => void, download: PluginFetch = fetch) {
  const local = isAbsolute(source);
  const response = local ? null : await fetchReleaseFile(new URL(release.archive.file, source).href, signal, download);
  assertPlugin(local || response?.body, 'Empty Flash plugin download.');
  const input = local ? createReadStream(join(dirname(source), release.archive.file), { signal }) : response!.body!;
  const output = await open(target, 'wx', 0o600); const hash = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of input) {
      signal.throwIfAborted(); bytes += chunk.length;
      assertPlugin(bytes <= release.archive.bytes, 'Flash package exceeds its declared size.');
      hash.update(chunk); await output.writeFile(chunk); progress(bytes, release.archive.bytes);
    }
    assertPlugin(bytes === release.archive.bytes && hash.digest('hex') === release.archive.sha256, 'Flash package checksum or size mismatch.');
  } finally { await output.close(); }
}
export async function extractPlugin(archive: string, destination: string, signal: AbortSignal) {
  const options = { cwd: destination, signal, timeout: 180_000, env: { PATH: '/usr/bin:/bin', LANG: 'C' } };
  const names = (await runFlashCommand('/usr/bin/tar', ['-tzf', archive], options)).trim().split('\n');
  assertPlugin(names.length > 0 && names.every(name => (name === 'flash/' || name.startsWith('flash/'))
    && !name.includes('\\') && !/[\x00-\x1f\x7f]/.test(name)
    && !name.split('/').some(part => part === '..' || part === '.')), 'Unsafe paths in Flash package.');
  const listing = (await runFlashCommand('/usr/bin/tar', ['-tvzf', archive], options)).trim().split('\n');
  assertPlugin(listing.length === names.length && listing.every(line => line.startsWith('-') || line.startsWith('d')),
    'Flash packages cannot contain links or special files.');
  const sizes = listing.map(line => Number(line.trim().split(/\s+/)[4]));
  assertPlugin(names.length <= 100_000 && new Set(names.map(name => name.replace(/\/$/, ''))).size === names.length
    && sizes.every(size => Number.isSafeInteger(size) && size >= 0)
    && sizes.reduce((total, size) => total + size, 0) <= 8 * 1024 ** 3, 'Flash package expands beyond its allowed limits or contains duplicate paths.');
  await runFlashCommand('/usr/bin/tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', destination], options);
  const root = join(destination, 'flash');
  assertPlugin(await realpath(root) === root, 'Flash package root was redirected.');
  return root;
}
