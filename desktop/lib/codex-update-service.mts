import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { codexVersion, codexUpdateDetail, DEFAULT_WORKER_CODEX_VERSION, newerCodexVersion, CODEX_UPDATE_STAGE_LABELS,
  type CodexUpdateState, type CodexWorkerVersions, type CodexUpdateReporter, type CodexUpdateStage } from '../shared/codex-update.ts';
import { createCodexInstallation } from './codex-update-installation.mts';

interface Options {
  filename: string;
  installation?: ReturnType<typeof createCodexInstallation>;
  workers(version: string, apply: boolean, report?: CodexUpdateReporter): Promise<CodexWorkerVersions>;
  now?: () => number;
}
export class CodexUpdateService {
  private readonly options: Options;
  private readonly installation: ReturnType<typeof createCodexInstallation>;
  private target: string | null = null;
  private pending: Promise<CodexUpdateState> | null = null;
  private initialized = false;
  private disposed = false;
  private timer?: ReturnType<typeof setInterval>;
  private lastCheck = 0;
  private lastProgressPublish = 0;
  private readonly listeners = new Set<(value: CodexUpdateState) => void>();
  private state: CodexUpdateState = { installedVersion: null, availableVersion: null, managed: false,
    busy: false, phase: 'idle', workers: { versions: [], pending: 0, waiting: 0, errors: [] },
    detail: 'Checking Codex…', error: null, revision: 0, progress: null };
  constructor(options: Options) {
    this.options = options;
    this.installation = options.installation ?? createCodexInstallation();
    try { this.target = codexVersion(JSON.parse(readFileSync(options.filename, 'utf8')).version); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.state.error = 'Saved Codex update state could not be read.'; }
  }
  workerVersion = () => this.target ?? DEFAULT_WORKER_CODEX_VERSION;
  snapshot = (): CodexUpdateState => structuredClone(this.state);
  subscribe(listener: (value: CodexUpdateState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish() { this.state.revision++; for (const listener of this.listeners) listener(this.snapshot()); }
  private now = () => this.options.now?.() ?? Date.now();
  private report: CodexUpdateReporter = stage => {
    if (!this.state.busy || this.disposed || !this.state.progress) return;
    const now = this.now();
    this.state.progress.updatedAt = now;
    if (stage) {
      this.state.progress.stage = stage;
      this.state.detail = CODEX_UPDATE_STAGE_LABELS[stage];
    }
    if (stage || now - this.lastProgressPublish >= 1000) {
      this.lastProgressPublish = now;
      this.publish();
    }
  };
  private progressReporter(): CodexUpdateReporter {
    const progress = this.state.progress;
    return stage => { if (this.state.progress === progress) this.report(stage); };
  }
  get() {
    if (this.pending) return Promise.resolve(this.snapshot());
    if (!this.initialized) return this.check();
    return Promise.resolve(this.snapshot());
  }
  check() { return this.perform('checking', async () => {
    this.lastCheck = Date.now();
    await this.inspect();
    this.report('checking-release');
    let releaseFinished = false;
    const checks = await Promise.allSettled([
      this.inspectWorkers(false).finally(() => { if (!releaseFinished) this.report('checking-release'); }),
      this.installation.available().then(version => { this.state.availableVersion = version; this.report(); })
        .finally(() => { releaseFinished = true; }),
    ]);
    const errors = checks.flatMap(result => result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : 'Codex status check failed.'] : []);
    if (errors.length) throw new Error(errors.join(' '));
  }); }
  install() { return this.perform('local', async () => {
    await this.inspect();
    this.report('checking-release');
    this.state.availableVersion = await this.installation.available();
    if (!this.state.managed) throw new Error('Update this Codex installation with its original installer.');
    if (newerCodexVersion(this.state.availableVersion, this.state.installedVersion!)) {
      this.report('updating-local');
      const previousVersion = this.state.installedVersion!;
      const installed = await this.installation.upgrade(this.progressReporter());
      this.state.installedVersion = installed.version;
      if (newerCodexVersion(this.state.availableVersion, installed.version)) {
        throw new Error('Homebrew finished, but the active Codex version is still older than the available release. Retry the update.');
      }
      this.state.localUpdated = newerCodexVersion(installed.version, previousVersion);
    }
    await this.selectWorkers();
  }); }
  syncWorkers() { return this.perform('workers', async () => { await this.inspect(); await this.selectWorkers(); }); }
  private async inspect() {
    this.report('checking-local');
    const local = await this.installation.inspect();
    this.state.installedVersion = local.version; this.state.managed = local.managed;
    this.report(); this.publish();
  }
  private async selectWorkers() {
    const version = codexVersion(this.state.installedVersion);
    await mkdir(dirname(this.options.filename), { recursive: true });
    await writeFile(`${this.options.filename}.tmp`, JSON.stringify({ version }), { mode: 0o600 });
    await rename(`${this.options.filename}.tmp`, this.options.filename);
    this.target = version;
    this.state.phase = 'workers'; this.report('preparing-worker');
    await this.inspectWorkers(true);
  }
  private async inspectWorkers(apply: boolean) {
    this.report('checking-workers');
    this.state.workers = await this.options.workers(apply ? this.workerVersion() : this.state.installedVersion ?? this.workerVersion(), apply, this.progressReporter());
    if (this.state.workers.errors.length) throw new Error(`Workers pending. ${this.state.workers.errors.join(' ')} Retry Update workers.`);
  }
  private perform(phase: CodexUpdateState['phase'], action: () => Promise<void>): Promise<CodexUpdateState> {
    if (this.pending) return this.pending;
    if (this.disposed) return Promise.reject(new Error('Codex updates are shutting down.'));
    this.state.localUpdated = false;
    const stage: CodexUpdateStage = phase === 'workers' ? 'checking-workers' : 'checking-local';
    const now = this.now();
    this.state.busy = true; this.state.phase = phase; this.state.error = null;
    this.state.progress = { stage, startedAt: now, updatedAt: now };
    this.state.detail = CODEX_UPDATE_STAGE_LABELS[stage]; this.lastProgressPublish = now; this.publish();
    this.pending = (async () => {
      try { await action(); }
      catch (error) { this.state.error = error instanceof Error ? error.message : 'Codex update failed. Retry when ready.'; }
      finally {
        this.initialized = true; this.state.busy = false; this.state.phase = 'idle'; this.state.progress = null;
        this.state.detail = this.state.error ?? codexUpdateDetail(this.state); this.pending = null; this.publish();
      }
      return this.snapshot();
    })();
    return this.pending;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.pending || this.disposed) return;
      if (this.target && this.target === this.state.installedVersion && this.state.workers.pending > 0 && !this.state.error) {
        void this.perform('workers', () => this.inspectWorkers(true));
      } else if (Date.now() - this.lastCheck > 6 * 60 * 60_000) void this.check();
    }, 30_000);
    this.timer.unref();
    void this.check();
  }
  dispose() { this.disposed = true; clearInterval(this.timer); this.installation.dispose(); this.listeners.clear(); }
}
