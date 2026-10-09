import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Binding } from '../agent-orchestration/mailbox.mts';
import { platformPaths, revision } from './git-workspaces.mts';
import { assertWorktree, createWorktree, initializeRepository } from './managed-worktrees.mts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Identity = Pick<Binding, 'workspace' | 'engineId' | 'agentId' | 'accountId'>;
export interface WorkerWorkspace { workspace: string; branch: string; baseCommit: string }

/** Persistent per-Homie workspaces. Neither restart nor a follow-up resets saved changes. */
export class WorkerWorkspaces {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  root(binding: Pick<Identity, 'workspace' | 'engineId'>) {
    return join(this.directory, hash(`${binding.workspace}\n${binding.engineId}`));
  }
  private location(binding: Identity) {
    const directory = join(this.root(binding), 'worker-workspaces');
    const id = hash(JSON.stringify([binding.agentId, binding.accountId]));
    return { directory, filename: join(directory, `${id}.json`),
      workspace: join(directory, `repository-homie-${id}`), branch: `worktree/feature/homie-${id}` };
  }
  async existing(binding: Identity): Promise<WorkerWorkspace | null> {
    const location = this.location(binding);
    let text: string;
    try { text = await readFile(location.filename, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const saved = JSON.parse(text) as Record<string, unknown>;
    if ((await lstat(location.filename)).isSymbolicLink() || saved.version !== 1 || saved.state !== 'ready'
      || saved.source !== binding.workspace || saved.engineId !== binding.engineId
      || saved.agentId !== binding.agentId || saved.accountId !== binding.accountId
      || saved.workspace !== location.workspace || saved.branch !== location.branch
      || typeof saved.baseCommit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(saved.baseCommit)) {
      throw new Error('Saved Homie workspace needs inspection. Its files will not be replaced.');
    }
    await assertWorktree(location.directory, location);
    return { workspace: location.workspace, branch: location.branch, baseCommit: saved.baseCommit };
  }
  async ensure(binding: Identity): Promise<WorkerWorkspace> {
    const location = this.location(binding);
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
      const existing = await this.existing(binding);
      if (existing) return existing;
      const hasHistory = (await readdir(location.directory)).some(file => file.endsWith('.json') || file.startsWith('repository-homie-'));
      await initializeRepository(location.directory, binding.workspace, hasHistory);
      const baseCommit = await revision(binding.workspace, 'HEAD');
      const record = { version: 1, state: 'preparing', source: binding.workspace, engineId: binding.engineId,
        agentId: binding.agentId, accountId: binding.accountId, workspace: location.workspace, branch: location.branch, baseCommit };
      await writeFile(location.filename, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await createWorktree(location.directory, binding.workspace, baseCommit, location);
      await writeFile(`${location.filename}.tmp`, JSON.stringify({ ...record, state: 'ready' }), { mode: 0o600 });
      await rename(`${location.filename}.tmp`, location.filename);
      return { workspace: location.workspace, branch: location.branch, baseCommit };
    } finally { await rmdir(lock); }
  }
}
