import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { commitId, identifier } from './contracts.mts';
import { git, revision } from './git-workspaces.mts';

export const managedRepository = (directory: string) => join(directory, 'repository');
export function worktreeLocation(directory: string, kind: 'task' | 'integration', id: string) {
  const slug = `${kind}-${identifier(id)}`;
  return { workspace: join(directory, `repository-${slug}`),
    branch: `worktree/${kind === 'task' ? 'feature' : 'experiment'}/${slug}` };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Serialize shared ref/provisioning changes across processes, without stealing crash locks. */
async function withRepositoryLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(directory, 'repository.lock'), deadline = Date.now() + 120_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assertLockWait(deadline);
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await operation(); } finally { await rmdir(lock); }
}
function assertLockWait(deadline: number): void {
  if (Date.now() >= deadline) throw new Error('Managed repository is locked. Inspect repository.lock before retrying; it is never removed automatically.');
}

async function assertRepository(directory: string, source: string): Promise<string> {
  const repository = managedRepository(directory);
  if ((await lstat(repository)).isSymbolicLink() || await realpath(repository) !== repository
    || (await git(repository, ['rev-parse', '--is-bare-repository'])).trim() !== 'true'
    || (await git(repository, ['config', '--local', '--get', 'cheshi.platformSource'])).trim() !== source) {
    throw new Error('Managed repository identity changed. Inspect it before continuing.');
  }
  return repository;
}

export async function initializeRepository(directory: string, source: string, hasHistory: boolean): Promise<void> {
  await withRepositoryLock(directory, async () => {
    const repository = managedRepository(directory);
    if (!await exists(repository)) {
      assertCanInitialize(hasHistory);
      // A failed clone stays at its unique staging path for inspection. Never replace existing evidence.
      const staging = join(directory, `repository-initializing-${randomUUID()}`);
      await git(directory, ['clone', '--bare', '--no-local', '--no-hardlinks', '--template=', '--', source, staging]);
      await git(staging, ['remote', 'remove', 'origin']);
      await git(staging, ['config', '--local', 'cheshi.platformSource', source]);
      await rename(staging, repository);
    }
    await assertRepository(directory, source);
  });
}
function assertCanInitialize(hasHistory: boolean): void {
  if (hasHistory) throw new Error('Managed repository is missing but saved work exists. Restore the repository; do not recreate it over saved evidence.');
}

export async function createWorktree(directory: string, source: string, base: string, location: { workspace: string; branch: string }): Promise<void> {
  commitId(base);
  await withRepositoryLock(directory, async () => {
    const repository = await assertRepository(directory, source);
    // Fetch only a missing source commit, then retain it independently of source branch movement.
    let present = false;
    try { present = await revision(repository, base) === base; } catch { /* Import this new base below. */ }
    if (!present) await git(repository, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', '--no-recurse-submodules', '--', source, base]);
    await git(repository, ['update-ref', `refs/cheshi/bases/${base}`, base]);
    if ((await git(repository, ['ls-tree', '-r', base])).split('\n').some(line => line.startsWith('160000 '))) {
      throw new Error('Submodules require a separate workspace provisioning policy.');
    }
    const registered = (await git(repository, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
    if (registered.includes(`worktree ${location.workspace}`) || await exists(location.workspace)) {
      throw new Error('Worktree already exists. Inspect the retained attempt instead of replacing it.');
    }
    await git(repository, ['worktree', 'add', '-b', location.branch, location.workspace, base]);
    await assertWorktree(directory, location);
  });
}

/** Host Git alone may use the common object store, refs and per-worktree indexes. */
export async function assertWorktree(directory: string, location: { workspace: string; branch: string }): Promise<void> {
  const { workspace, branch } = location;
  const metadata = await lstat(join(workspace, '.git'));
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(workspace) !== workspace
    || await realpath((await git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()) !== managedRepository(directory)
    || (await git(workspace, ['symbolic-ref', 'HEAD'])).trim() !== `refs/heads/${branch}`) {
    throw new Error('Worktree Git identity changed. Inspect the retained attempt.');
  }
}
