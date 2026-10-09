import { isIntakeWorkspace } from '../../../experiments/codex-specialists/src/task-workspace.ts';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Binding } from '../agent-orchestration/mailbox.mts';
import { git, platformPaths, revision } from './git-workspaces.mts';
import { assertWorktree, createWorktree, initializeRepository } from './managed-worktrees.mts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Identity = Pick<Binding, 'workspace' | 'engineId' | 'agentId' | 'accountId'>;
export interface WorkerWorkspace { workspace: string; branch: string; baseCommit: string }
export interface WorkerWorkspaceRecord extends WorkerWorkspace { baseBranch: string | null; kind: 'task' | 'intake' | 'legacy' }

/** Task worktrees share objects, never working files. Null addresses the retained legacy workspace. */
export class WorkerWorkspaces {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  root(binding: Pick<Identity, 'workspace' | 'engineId'>) {
    return join(this.directory, hash(`${binding.workspace}\n${binding.engineId}`));
  }
  private location(binding: Identity, taskId: string | null = null) {
    if (taskId !== null && !isIntakeWorkspace(taskId) && !/^[a-zA-Z0-9_-]{1,80}$/.test(taskId)) throw new TypeError('Invalid task workspace identity.');
    const directory = join(this.root(binding), 'worker-workspaces');
    const id = hash(JSON.stringify([binding.agentId, binding.accountId, ...(taskId === null ? [] : [taskId])]));
    const kind = taskId === null ? 'homie' : 'task';
    return { directory, filename: join(directory, `${id}.json`),
      workspace: join(directory, `repository-${kind}-${id}`), branch: `worktree/feature/${kind}-${id}` };
  }
  async existing(binding: Identity, taskId: string | null = null): Promise<WorkerWorkspace | null> {
    const saved = await this.record(binding, taskId);
    if (!saved) return null;
    await assertWorktree(this.location(binding, taskId).directory, saved);
    return { workspace: saved.workspace, branch: saved.branch, baseCommit: saved.baseCommit };
  }
  private async record(binding: Identity, taskId: string | null): Promise<WorkerWorkspaceRecord | null> {
    const location = this.location(binding, taskId);
    let text: string;
    try { text = await readFile(location.filename, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const saved = JSON.parse(text) as Record<string, unknown>;
    if ((await lstat(location.filename)).isSymbolicLink() || saved.version !== 1 || (saved.taskId ?? null) !== taskId || saved.state !== 'ready'
      || saved.source !== binding.workspace || saved.engineId !== binding.engineId
      || saved.agentId !== binding.agentId || saved.accountId !== binding.accountId
      || saved.workspace !== location.workspace || saved.branch !== location.branch
      || typeof saved.baseCommit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(saved.baseCommit)
      || (saved.baseBranch != null && (typeof saved.baseBranch !== 'string' || !saved.baseBranch.startsWith('refs/heads/') || saved.baseBranch.length > 1000))) {
      throw new Error('Saved Homie workspace needs inspection. Its files will not be replaced.');
    }
    return { workspace: location.workspace, branch: location.branch, baseCommit: saved.baseCommit,
      baseBranch: saved.baseBranch as string | null ?? null, kind: taskId === null ? 'legacy' : isIntakeWorkspace(taskId) ? 'intake' : 'task' };
  }
  private legacyFile(binding: Identity) { return `${this.location(binding).filename}.legacy-tasks`; }
  async retainLegacyTasks(binding: Identity, taskIds: string[]): Promise<void> {
    const ids = [...new Set(taskIds)].sort();
    for (const id of ids) this.location(binding, id);
    try { await writeFile(this.legacyFile(binding), JSON.stringify(ids), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  async recordIntakeView(binding: Identity, taskId: string, key: string): Promise<void> {
    if (!isIntakeWorkspace(key)) throw new Error('Only a read-only intake baseline can be recorded as a task view.');
    const filename = `${this.location(binding, taskId).filename}.view`;
    await writeFile(`${filename}.tmp`, JSON.stringify({ taskId, key }), { mode: 0o600 });
    await rename(`${filename}.tmp`, filename);
  }
  async forTask(binding: Identity, taskId: string): Promise<WorkerWorkspace | null> {
    return this.resolveTask(binding, taskId, key => this.existing(binding, key));
  }
  async describeTask(binding: Identity, taskId: string): Promise<WorkerWorkspaceRecord | null> {
    return this.resolveTask(binding, taskId, key => this.record(binding, key));
  }
  private async resolveTask<T>(binding: Identity, taskId: string, load: (key: string | null) => Promise<T | null>): Promise<T | null> {
    const saved = await load(taskId);
    if (saved) return saved;
    let view: Record<string, unknown> | null = null;
    try { view = JSON.parse(await readFile(`${this.location(binding, taskId).filename}.view`, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (view) {
      if (view.taskId !== taskId || typeof view.key !== 'string' || !isIntakeWorkspace(view.key)) throw new Error('Invalid saved intake view.');
      return load(view.key);
    }
    let legacy: unknown;
    try { legacy = JSON.parse(await readFile(this.legacyFile(binding), 'utf8')); }
    catch (error) {
      // Before the first upgrade, every saved Worker message belongs to the legacy workspace.
      // Once the migration allowlist exists, missing new tasks must never fall back to it.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return load(null);
      throw error;
    }
    if (!Array.isArray(legacy) || !legacy.every(id => typeof id === 'string')) throw new Error('Invalid retained task identities.');
    return legacy.includes(taskId) ? load(null) : null;
  }
  async ensure(binding: Identity, taskId: string | null = null): Promise<WorkerWorkspace> {
    const location = this.location(binding, taskId);
    await platformPaths(binding.workspace, location.directory);
    const lock = `${location.filename}.lock`;
    // A crash leaves the lease for inspection; never steal a lock from another process.
    const deadline = Date.now() + 120_000;
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('Homie workspace is locked. Inspect the retained lease before retrying.');
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
    }
    try {
      const existing = await this.existing(binding, taskId);
      if (existing) return existing;
      const hasHistory = (await readdir(location.directory)).some(file => file.endsWith('.json') || file.startsWith('repository-homie-') || file.startsWith('repository-task-'));
      await initializeRepository(location.directory, binding.workspace, hasHistory);
      const baseCommit = isIntakeWorkspace(taskId) ? taskId.slice('@intake:'.length) : await revision(binding.workspace, 'HEAD');
      const reference = (await git(binding.workspace, ['rev-parse', '--symbolic-full-name', 'HEAD'])).trim();
      const baseBranch = reference.startsWith('refs/heads/') && await revision(binding.workspace, 'HEAD') === baseCommit ? reference : null;
      const record = { version: 1, state: 'preparing', source: binding.workspace, engineId: binding.engineId,
        agentId: binding.agentId, accountId: binding.accountId, ...(taskId === null ? {} : { taskId }), workspace: location.workspace, branch: location.branch, baseCommit, baseBranch };
      await writeFile(location.filename, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await createWorktree(location.directory, binding.workspace, baseCommit, location);
      await writeFile(`${location.filename}.tmp`, JSON.stringify({ ...record, state: 'ready' }), { mode: 0o600 });
      await rename(`${location.filename}.tmp`, location.filename);
      return { workspace: location.workspace, branch: location.branch, baseCommit };
    } finally { await rmdir(lock); }
  }
}
