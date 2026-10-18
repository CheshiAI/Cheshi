import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FlashInstaller } from '../desktop/lib/flash/installer.mts';
import { flashInstallationPaths, inspectFlashInstallation } from '../desktop/lib/flash/installation.mts';
import { FlashRuntime } from '../desktop/lib/flash/runtime.mts';
import { callFlash } from '../desktop/lib/flash/client.mts';
import { pluginSelection } from '../desktop/lib/flash/plugin-package.mts';

const [manifest, cache] = process.argv.slice(2);
if (!manifest || !cache) throw new Error('Usage: bun scripts/verify-flash-plugin.mts /path/release.json /path/model-cache');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'fp-')));
const previousCache = process.env.CHESHI_FLASH_MODEL_CACHE;
process.env.CHESHI_FLASH_MODEL_CACHE = resolve(cache);
const installer = new FlashInstaller({ userData: directory, source: resolve(manifest), enabled: () => false,
  readiness: () => inspectFlashInstallation(flashInstallationPaths(directory)) });
let runtime: FlashRuntime | undefined;
try {
  const release = await installer.checkUpdates();
  assert.ok(release.availableVersion);
  const installed = await installer.install();
  assert.equal(installed.ready, true);
  assert.equal(installed.installedVersion, release.availableVersion);
  const paths = flashInstallationPaths(directory);
  assert.ok(paths.executable.startsWith(join(directory, 'plugins/flash/versions')));
  await mkdir(join(directory, 'flash'), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'flash/verification-marker'), 'preserve');
  runtime = new FlashRuntime({ directory: join(directory, 'flash'), executable: paths.executable,
    modelCache: paths.modelCache, device: 'cpu', startupTimeoutMs: 180_000 });
  const status = await runtime.transaction(connection => callFlash<{ state: string; capabilities: string[] }>(connection,
    'status', {}, new AbortController().signal), new AbortController().signal);
  assert.equal(status.state, 'ready');
  assert.ok(status.capabilities.includes('memory.turns.v1'));
  await runtime.release(); runtime = undefined;
  assert.equal((await installer.uninstall()).ready, false);
  assert.equal(pluginSelection(directory).version, null);
  assert.equal(await readFile(join(directory, 'flash/verification-marker'), 'utf8'), 'preserve');
  const database = await readFile(join(directory, 'flash/index.sqlite'));
  assert.ok(database.byteLength > 0);
  console.log(JSON.stringify({ version: installed.installedVersion, packageInstalled: true, modelLoaded: true,
    serviceReady: true, removed: true, conversationDatabasePreserved: true, sharedModelCache: 'read-only reuse' }, null, 2));
} finally {
  await runtime?.release(); installer.dispose();
  if (previousCache === undefined) delete process.env.CHESHI_FLASH_MODEL_CACHE;
  else process.env.CHESHI_FLASH_MODEL_CACHE = previousCache;
  await rm(directory, { recursive: true, force: true });
}
