import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HostPythonRuntime } from '../agent-management/host-python-runtime.mts';
import type { FlashReadiness } from '../../shared/settings.ts';
import { FLASH_MODEL, FLASH_MODEL_REVISION, FLASH_REVISION, flashInstallationPaths, inspectFlashInstallation } from './installation.mts';

const execute = promisify(execFile);
export type FlashInstallCommand = (file: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeout: number;
}) => Promise<string>;
const command: FlashInstallCommand = async (file, args, options) => {
  const result = await execute(file, args, { ...options, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' });
  return result.stdout;
};
interface Options {
  userData: string;
  enabled(): boolean;
  readiness(): Promise<FlashReadiness>;
  run?: FlashInstallCommand;
  python?: Pick<HostPythonRuntime, 'prepare' | 'dispose'>;
  paths?: ReturnType<typeof flashInstallationPaths>;
}

/** Install a pinned service in persistent app storage; never pull or reset a user's checkout. */
export class FlashInstaller {
  private readonly options: Options;
  private readonly python: Pick<HostPythonRuntime, 'prepare' | 'dispose'>;
  private readonly stopped = new AbortController();
  private pending: Promise<FlashReadiness> | null = null;
  private progress: string | null = null;
  private failure: string | null = null;
  constructor(options: Options) {
    this.options = options;
    this.python = options.python ?? new HostPythonRuntime(join(options.userData, 'flash-install', 'python'));
  }
  async status(): Promise<FlashReadiness> {
    if (this.pending) return { ready: false, installing: true, detail: this.progress ?? 'Preparing Flash…' };
    const result = await this.options.readiness();
    return this.failure ? { ...result, detail: this.failure } : result;
  }
  isInstalling = () => this.pending !== null;
  install(): Promise<FlashReadiness> {
    if (this.pending) return this.pending;
    if (this.options.enabled()) return Promise.reject(new Error('Turn Flash off before installing.'));
    this.failure = null;
    const operation = this.prepare();
    this.pending = operation;
    void operation.finally(() => { this.pending = null; this.progress = null; }).catch(() => {});
    return operation;
  }
  private async prepare(): Promise<FlashReadiness> {
    const paths = this.options.paths ?? flashInstallationPaths(this.options.userData);
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(60 * 60_000)]);
    const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_DEBUG: '',
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', PIP_NO_INPUT: '1', HF_HUB_OFFLINE: '0',
      TRANSFORMERS_OFFLINE: '0', HF_HUB_DISABLE_PROGRESS_BARS: '1', UV_NO_PROGRESS: '1',
      UV_PROJECT_ENVIRONMENT: join(paths.repository, '.venv'), UV_PYTHON_DOWNLOADS: 'never' };
    const run = (file: string, args: string[], cwd = paths.root, timeout = 30 * 60_000) =>
      (this.options.run ?? command)(file, args, { cwd, env, signal, timeout });
    let staging: string | undefined;
    let unlock: (() => Promise<void>) | undefined;
    try {
      signal.throwIfAborted();
      await mkdir(paths.root, { recursive: true, mode: 0o700 });
      unlock = await lockInstallation(join(paths.root, 'installation.lock'));
      this.progress = 'Downloading the Flash service from GitHub…';
      let present = false;
      try { present = (await stat(paths.repository)).isDirectory(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!present) {
        staging = await mkdtemp(join(paths.root, '.source-'));
        await run('gh', ['repo', 'clone', 'https://github.com/CheshiAI/Cheshi-flash.git', staging, '--no-upstream'], paths.root, 120_000);
        await run('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', FLASH_REVISION], staging, 30_000);
        await rename(staging, paths.repository); staging = undefined;
      }
      const revision = (await run('git', ['rev-parse', 'HEAD'], paths.repository, 10_000)).trim();
      const changes = (await run('git', ['status', '--porcelain', '--untracked-files=no'], paths.repository, 10_000)).trim();
      this.assertInstallation(revision === FLASH_REVISION && !changes,
        'The managed Flash source has changed. Restore its pinned version before installing.');
      const identity = JSON.parse(await readFile(join(paths.repository, 'src/cheshi_flash/identity.json'), 'utf8'));
      this.assertInstallation(identity.model === FLASH_MODEL && identity.revision === FLASH_MODEL_REVISION,
        'The Flash service and model versions do not match. Update Cheshi before installing.');
      this.progress = 'Preparing Python and installing Flash dependencies…';
      const python = await this.python.prepare();
      signal.throwIfAborted();
      const tooling = join(paths.root, 'installer');
      await run(python.executable, ['-m', 'venv', tooling]);
      const toolingPython = join(tooling, 'bin/python');
      await run(toolingPython, ['-m', 'pip', 'install', '--disable-pip-version-check', 'uv==0.11.32']);
      await run(join(tooling, 'bin/uv'), ['sync', '--frozen', '--extra', 'model', '--no-dev', '--python', python.executable], paths.repository);
      this.progress = 'Downloading EmbeddingGemma 2. Existing model files will be reused…';
      await run(join(paths.repository, '.venv/bin/python'), ['-c',
        'import sys; from huggingface_hub import snapshot_download; snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], cache_dir=sys.argv[3])',
        FLASH_MODEL, FLASH_MODEL_REVISION, paths.modelCache]);
      this.progress = 'Checking the installed executable and model files…';
      const result = await inspectFlashInstallation({ executable: paths.managedExecutable, modelCache: paths.modelCache });
      this.assertInstallation(result.ready, result.detail);
      return await this.options.readiness();
    } catch (error) {
      // Do not expose subprocess output: Git and package tools may include credentials in their diagnostics.
      this.failure = error instanceof InstallationError ? error.message
        : `Flash installation failed during: ${this.progress ?? 'preparation'} Check GitHub CLI sign-in, access to CheshiAI/Cheshi-flash, network access and free disk space, then retry.`;
      throw new Error(this.failure);
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
      await unlock?.();
    }
  }
  private assertInstallation(condition: boolean, message: string): asserts condition {
    if (!condition) throw new InstallationError(message);
  }
  dispose() { this.stopped.abort(); this.python.dispose(); }
}
class InstallationError extends Error {}

async function lockInstallation(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
      return () => unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      let running = true;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') running = false; }
      }
      if (running) return installationLocked();
      await unlink(path);
    }
  }
  return installationLocked();
}
function installationLocked(): never { throw new InstallationError('Another Cheshi process is installing Flash. Wait for it to finish, then retry.'); }
