import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FlashInstallProgress, FlashReadiness } from '../../shared/settings.ts';
import { FLASH_MODEL, FLASH_MODEL_REVISION, flashInstallationPaths, inspectFlashInstallation } from './installation.mts';
import { FLASH_MODEL_DOWNLOAD_SCRIPT, flashDownloadProgressReader, runFlashCommand } from './model-download.mts';
import { assertPlugin, defaultPluginSource, downloadPlugin, extractPlugin, FlashPluginError, loadPluginRelease, newerPlugin,
  parsePluginManifest, pluginRoot, pluginSelection, pluginVersionPath, resolvePluginSource, selectPlugin,
  type FlashPluginRelease, type PluginFetch } from './plugin-package.mts';
import { lockPluginInstallation } from './plugin-lock.mts';
import { FlashRuntime } from './runtime.mts';

interface Options {
  userData: string;
  enabled(): boolean;
  readiness(): Promise<FlashReadiness>;
  source?: string;
  download?: PluginFetch;
  verify?: (root: string, release: FlashPluginRelease, signal: AbortSignal) => Promise<void>;
  prepareModel?: (root: string, signal: AbortSignal, output: (chunk: string) => void) => Promise<void>;
}
const complete = 'Flash plugin installation complete. Enable Flash to check and load the model.';
export class FlashInstaller {
  private readonly options: Options;
  private readonly stopped = new AbortController();
  private pending: Promise<FlashReadiness> | null = null;
  private detail = '';
  private progress: FlashInstallProgress | undefined;
  private failure: string | null = null;
  private available: FlashPluginRelease | null = null;
  constructor(options: Options) { this.options = options; }
  isInstalling = () => this.pending !== null;
  async status(): Promise<FlashReadiness> {
    const selection = pluginSelection(this.options.userData);
    const versions = { installedVersion: selection.version ?? undefined,
      availableVersion: this.available && (!selection.version || newerPlugin(this.available.version, selection.version)) ? this.available.version : undefined };
    if (this.pending) return { ready: false, installing: true, detail: this.detail, progress: this.progress, ...versions };
    const result = await this.options.readiness();
    return { ...result, ...versions, detail: this.failure ?? result.detail };
  }
  async checkUpdates(source?: string): Promise<FlashReadiness> {
    assertPlugin(!this.pending, 'Wait for the current Flash operation to finish.');
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(30_000)]);
    this.available = null;
    this.available = await this.release(await this.source(source), signal);
    this.failure = null;
    return this.status();
  }
  install(source?: string): Promise<FlashReadiness> {
    return this.operation('Preparing Flash plugin…', async signal => this.prepare(await this.source(source), signal));
  }
  uninstall(): Promise<FlashReadiness> {
    return this.operation('Removing Flash plugin…', async () => {
      await selectPlugin(this.options.userData, null);
      await rm(join(pluginRoot(this.options.userData), 'versions'), { recursive: true, force: true });
      return { ready: false, detail: 'Flash plugin removed. Saved conversations and model files have been kept.' };
    });
  }
  private operation(detail: string, task: (signal: AbortSignal) => Promise<FlashReadiness>): Promise<FlashReadiness> {
    if (this.pending) return Promise.reject(new Error('Wait for the current Flash operation to finish.'));
    if (this.options.enabled()) return Promise.reject(new Error('Turn Flash off before changing its installation.'));
    this.failure = null; this.detail = detail;
    this.progress = { startedAt: Date.now() };
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(60 * 60_000)]);
    const operation = this.locked(task, signal);
    this.pending = operation;
    void operation.finally(() => { this.pending = null; this.progress = undefined; }).catch(() => {});
    return operation;
  }
  private async locked(task: (signal: AbortSignal) => Promise<FlashReadiness>, signal: AbortSignal) {
    const root = pluginRoot(this.options.userData);
    let unlock: (() => Promise<void>) | undefined;
    try {
      signal.throwIfAborted();
      await mkdir(root, { recursive: true, mode: 0o700 });
      assertPlugin(await realpath(root) === root, 'Flash plugin storage cannot be redirected.');
      unlock = await lockPluginInstallation(join(root, 'installation.lock'));
      return await task(signal);
    } catch (error) {
      // Never copy subprocess output, paths or credentials into renderer diagnostics.
      this.failure = `Flash operation failed during: ${this.detail} The previous version is retained if installation did not finish. Check the release package, network and free disk space, then retry.`;
      if (error instanceof FlashPluginError) this.failure = error.message;
      throw new Error(this.failure);
    } finally { await unlock?.(); }
  }
  private source(source?: string) {
    return resolvePluginSource(source?.trim() || this.options.source || defaultPluginSource());
  }
  private async release(source: string, signal: AbortSignal) {
    const release = await loadPluginRelease(source, signal, this.options.download);
    assertPlugin(release.platform === process.platform && release.arch === process.arch, 'Flash plugin platform is incompatible.');
    assertPlugin(release.model === FLASH_MODEL && release.modelRevision === FLASH_MODEL_REVISION, 'Flash model version is incompatible.');
    return release;
  }
  private async prepare(source: string, signal: AbortSignal): Promise<FlashReadiness> {
    const release = await this.release(source, signal); this.available = release;
    const selection = pluginSelection(this.options.userData);
    assertPlugin(!selection.version || !newerPlugin(selection.version, release.version), 'Flash plugin downgrades are not supported.');
    const root = pluginRoot(this.options.userData), staging = await mkdtemp(join(root, '.install-'));
    const startedAt = this.progress!.startedAt;
    const target = pluginVersionPath(this.options.userData, release.version);
    let backup: string | undefined;
    let preserveStaging = false;
    try {
      this.detail = 'Downloading Flash plugin package…';
      const archive = join(staging, 'plugin.tar.gz');
      await downloadPlugin(source, release, archive, signal,
        (downloadedBytes, totalBytes) => { this.progress = { startedAt, downloadedBytes, totalBytes, phase: 'package' }; }, this.options.download);
      this.detail = 'Unpacking and checking Flash plugin…'; this.progress = { startedAt };
      const candidate = await extractPlugin(archive, staging, signal);
      const manifest = parsePluginManifest(JSON.parse(await readFile(join(candidate, 'plugin.json'), 'utf8')));
      const { archive: _archive, ...metadata } = release;
      assertPlugin(JSON.stringify(manifest) === JSON.stringify(metadata), 'Flash package manifest differs from release metadata.');
      await (this.options.verify ?? verifyFlashPlugin)(candidate, release, signal);
      this.detail = 'Downloading EmbeddingGemma 2. Existing model files will be reused…';
      const output = flashDownloadProgressReader(startedAt, progress => { this.progress = { ...progress, phase: 'model' }; });
      if (this.options.prepareModel) await this.options.prepareModel(candidate, signal, output);
      else {
        const paths = flashInstallationPaths(this.options.userData);
        const existing = await inspectFlashInstallation({ executable: join(candidate, release.executable), modelCache: paths.modelCache });
        if (!existing.ready) {
          await runFlashCommand(join(candidate, release.python), ['-I', '-B', '-c', FLASH_MODEL_DOWNLOAD_SCRIPT,
            FLASH_MODEL, FLASH_MODEL_REVISION, paths.modelCache], { cwd: candidate, signal, timeout: 30 * 60_000,
            env: { ...process.env, HF_HUB_OFFLINE: '0', TRANSFORMERS_OFFLINE: '0', HF_HUB_DISABLE_PROGRESS_BARS: '1' }, onOutput: output });
        }
        const status = await inspectFlashInstallation({ executable: join(candidate, release.executable), modelCache: paths.modelCache });
        assertPlugin(status.ready, status.detail);
        this.detail = 'Checking Flash service compatibility and loading the model…'; this.progress = { startedAt };
        await verifyFlashStartup(join(candidate, release.executable), paths.modelCache, signal);
      }
      this.detail = 'Finishing Flash plugin installation…'; this.progress = { startedAt };
      await writeFile(join(candidate, 'receipt.json'), JSON.stringify(release), { mode: 0o600 });
      await mkdir(join(root, 'versions'), { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      try { await rename(candidate, target); }
      catch (error) {
        assertPlugin(['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''), 'Could not publish Flash plugin.');
        const previous = JSON.parse(await readFile(join(target, 'receipt.json'), 'utf8')) as FlashPluginRelease;
        assertPlugin(previous.archive?.sha256 === release.archive.sha256, 'This Flash version already contains a different package.');
        const previousTarget = join(staging, 'previous');
        await rename(target, previousTarget);
        backup = previousTarget;
        await rename(candidate, target);
      }
      // Only this atomic pointer changes the active version; previous packages and all data remain intact.
      await selectPlugin(this.options.userData, release.version);
      return { ready: true, detail: complete, installedVersion: release.version };
    } catch (error) {
      if (backup) {
        // Keep the recovery folder if restoration itself fails; never discard the previous package.
        preserveStaging = true;
        await rm(target, { recursive: true, force: true });
        await rename(backup, target);
        preserveStaging = false;
      }
      throw error;
    } finally { if (!preserveStaging) await rm(staging, { recursive: true, force: true }); }
  }
  dispose() { this.stopped.abort(); }
}

export async function verifyFlashPlugin(root: string, release: FlashPluginRelease, signal: AbortSignal) {
  const python = join(root, release.python), executable = join(root, release.executable);
  assertPlugin(await realpath(python) === python && await realpath(executable) === executable, 'Flash entrypoints must be regular packaged files.');
  const options = { cwd: root, signal, timeout: 120_000,
    env: { PATH: '/usr/bin:/bin', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1' } };
  await runFlashCommand(executable, ['--help'], options);
  const result = await runFlashCommand(python, ['-I', '-B', '-c',
    'import json, numpy, torch, sentence_transformers, huggingface_hub; from cheshi_flash.embedding import model_identity; print(json.dumps(model_identity()))'], options);
  const identity = JSON.parse(result);
  assertPlugin(identity.model === release.model && identity.revision === release.modelRevision, 'Installed Flash model identity is incompatible.');
}

async function verifyFlashStartup(executable: string, modelCache: string, signal: AbortSignal) {
  // A separate short socket path avoids the Unix socket length limit and never migrates the user's DB.
  const directory = await mkdtemp(join(tmpdir(), 'flash-probe-'));
  const runtime = new FlashRuntime({ directory, executable, modelCache, device: 'cpu', startupTimeoutMs: 180_000 });
  const cancel = () => { void runtime.release(); };
  signal.addEventListener('abort', cancel, { once: true });
  try { signal.throwIfAborted(); await runtime.transaction(async () => {}, signal); }
  finally { signal.removeEventListener('abort', cancel); await runtime.release(); await rm(directory, { recursive: true, force: true }); }
}
