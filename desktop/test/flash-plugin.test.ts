import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FlashInstaller } from '../lib/flash/installer.mts';
import { FLASH_MODEL, FLASH_MODEL_REVISION, flashInstallationPaths } from '../lib/flash/installation.mts';
import { extractPlugin, loadPluginRelease, parsePluginRelease, pluginDigest, pluginSelection, pluginVersionPath,
  type FlashPluginManifest, type FlashPluginRelease } from '../lib/flash/plugin-package.mts';
import { deferred, rejection } from './flash-test-helpers.ts';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'flash-plugin-')));
  const source = join(root, 'release.json'), data = join(root, 'app');
  await mkdir(data);
  const build = async (version: string, broken = false) => {
    const stage = join(root, `source-${version}`), packageRoot = join(stage, 'flash');
    await mkdir(join(packageRoot, 'bin'), { recursive: true });
    await mkdir(join(packageRoot, 'python/bin'), { recursive: true });
    const manifest: FlashPluginManifest = { schema: 1, id: 'cheshi-flash', version, platform: 'darwin', arch: 'arm64',
      hostApi: 1, protocol: 1, executable: 'bin/cheshi-flash', python: 'python/bin/python3', model: FLASH_MODEL, modelRevision: FLASH_MODEL_REVISION };
    await writeFile(join(packageRoot, 'plugin.json'), JSON.stringify(manifest));
    await writeFile(join(packageRoot, 'bin/cheshi-flash'), broken ? 'broken' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(packageRoot, 'python/bin/python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const file = `cheshi-flash-${version}-darwin-arm64.tar.gz`, archive = join(root, file);
    execFileSync('/usr/bin/tar', ['-czf', archive, '-C', stage, 'flash']);
    const release: FlashPluginRelease = { ...manifest, archive: { file, bytes: (await stat(archive)).size, sha256: await pluginDigest(archive) } };
    await writeFile(source, JSON.stringify(release));
    return { release, archive, packageRoot };
  };
  const verify = async (target: string) => {
    if ((await readFile(join(target, 'bin/cheshi-flash'), 'utf8')) === 'broken') throw new Error('fixture failure');
  };
  const options = { userData: data, source, enabled: () => false,
    readiness: async () => ({ ready: pluginSelection(data).version !== null, detail: 'Fixture files' }), verify,
    prepareModel: async (_target: string, _signal: AbortSignal, output: (chunk: string) => void) => {
      output('{"downloadedBytes":20,"totalBytes":100}\n'); output('{"downloadedBytes":100,"totalBytes":100}\n');
    } };
  return { root, data, source, options, build, close: () => rm(root, { recursive: true, force: true }) };
}

test('plugin install, update discovery, failed update and removal preserve model and conversation data', async () => {
  const f = await fixture(), installer = new FlashInstaller(f.options);
  try {
    await mkdir(join(f.data, 'flash')); await writeFile(join(f.data, 'flash/index.sqlite'), 'conversation-marker');
    await mkdir(join(f.data, 'flash-install/models'), { recursive: true });
    await writeFile(join(f.data, 'flash-install/models/keep'), 'model-marker');
    await f.build('0.1.0');
    expect((await installer.checkUpdates()).availableVersion).toBe('0.1.0');
    expect(await installer.install()).toMatchObject({ ready: true, installedVersion: '0.1.0' });
    expect(flashInstallationPaths(f.data).executable).toBe(join(pluginVersionPath(f.data, '0.1.0'), 'bin/cheshi-flash'));
    await f.build('0.2.0', true);
    expect((await installer.checkUpdates()).availableVersion).toBe('0.2.0');
    await rejection(() => installer.install());
    expect(pluginSelection(f.data).version).toBe('0.1.0');
    expect((await installer.status()).ready).toBe(true);
    await f.build('0.3.0');
    expect((await installer.install()).installedVersion).toBe('0.3.0');
    expect((await stat(pluginVersionPath(f.data, '0.1.0'))).isDirectory()).toBe(true);
    expect((await installer.uninstall()).ready).toBe(false);
    expect(pluginSelection(f.data)).toEqual({ exists: true, version: null });
    expect(flashInstallationPaths(f.data).executable).toContain('not-installed');
    expect(await readFile(join(f.data, 'flash/index.sqlite'), 'utf8')).toBe('conversation-marker');
    expect(await readFile(join(f.data, 'flash-install/models/keep'), 'utf8')).toBe('model-marker');
  } finally { installer.dispose(); await f.close(); }
});

test('checksum mismatch and incompatible releases cannot activate or execute a package', async () => {
  const f = await fixture(); let verified = false;
  const installer = new FlashInstaller({ ...f.options, verify: async () => { verified = true; } });
  try {
    const { release, archive } = await f.build('0.1.0');
    await writeFile(archive, 'tampered');
    await rejection(() => installer.install()); expect(verified).toBe(false);
    expect(pluginSelection(f.data).exists).toBe(false);
    expect(() => parsePluginRelease({ ...release, hostApi: 2 })).toThrow('compatibility');
    expect(() => parsePluginRelease({ ...release, version: '../outside' })).toThrow();
    expect(() => parsePluginRelease({ ...release, archive: { ...release.archive, file: '../outside' } })).toThrow();
  } finally { installer.dispose(); await f.close(); }
});

test('a completed installation does not hide a later activation failure', async () => {
  const f = await fixture(); let detail = 'Files available';
  const installer = new FlashInstaller({ ...f.options, readiness: async () => ({ ready: true, detail }) });
  try {
    await f.build('0.1.0'); await installer.install();
    detail = 'Flash model initialization failed';
    expect((await installer.status()).detail).toBe(detail);
  } finally { installer.dispose(); await f.close(); }
});

test('reinstall repairs a damaged package without changing its version or receipt', async () => {
  const f = await fixture(), installer = new FlashInstaller(f.options);
  try {
    await f.build('0.1.0'); await installer.install();
    const executable = flashInstallationPaths(f.data).executable;
    await writeFile(executable, 'broken');
    expect((await installer.install()).installedVersion).toBe('0.1.0');
    expect(await readFile(executable, 'utf8')).toContain('exit 0');
  } finally { installer.dispose(); await f.close(); }
});

test('links in an archive are rejected before extraction', async () => {
  const f = await fixture();
  try {
    const { archive, packageRoot } = await f.build('0.1.0');
    await createSymbolicLink('/tmp', join(packageRoot, 'escape'));
    execFileSync('/usr/bin/tar', ['-czf', archive, '-C', join(f.root, 'source-0.1.0'), 'flash']);
    const destination = join(f.root, 'extract'); await mkdir(destination);
    expect(String(await rejection(() => extractPlugin(archive, destination, new AbortController().signal)))).toContain('links');
  } finally { await f.close(); }
});

test('installation publishes live progress, blocks concurrent removal, and refuses changes while enabled', async () => {
  const f = await fixture(), entered = deferred<void>(), hold = deferred<void>();
  const installer = new FlashInstaller({ ...f.options, prepareModel: async (_root, _signal, output) => {
    output('{"downloadedBytes":25,"totalBytes":100}\n'); entered.resolve(); await hold.promise;
  } });
  try {
    await f.build('0.1.0'); const installing = installer.install();
    await entered.promise;
    expect(await installer.status()).toMatchObject({ installing: true, progress: { phase: 'model', downloadedBytes: 25, totalBytes: 100 } });
    await rejection(() => installer.uninstall()); hold.resolve(); await installing;
    expect((await installer.status()).progress).toBeUndefined();
    const enabled = new FlashInstaller({ ...f.options, enabled: () => true });
    expect(String(await rejection(() => enabled.install()))).toContain('Turn Flash off');
    expect(String(await rejection(() => enabled.uninstall()))).toContain('Turn Flash off'); enabled.dispose();
  } finally { hold.resolve(); installer.dispose(); await f.close(); }
});

test('a release response is bounded and redirects cannot downgrade HTTPS or send credentials', async () => {
  const signal = new AbortController().signal;
  expect(String(await rejection(() => loadPluginRelease('https://github.com/owner/repo/release.json', signal,
    async () => new Response('x'.repeat(65537)))))).toContain('too large');
  expect(String(await rejection(() => loadPluginRelease('https://github.com/owner/repo/release.json', signal,
    async () => new Response(null, { status: 302, headers: { location: 'http://github.com/file' } }))))).toContain('destination');
});
