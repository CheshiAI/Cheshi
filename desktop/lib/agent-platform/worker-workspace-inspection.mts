import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Binding } from '../agent-orchestration/mailbox.mts';
import type { WorkerWorkspaceInspection } from '../../shared/worker-workspace.ts';
import { WorkerWorkspaces } from './worker-workspaces.mts';
import { assertWorktree } from './managed-worktrees.mts';
import { git } from './git-workspaces.mts';

const DIFF_LIMIT = 160000;
async function untrackedPatch(workspace: string, path: string): Promise<string> {
  const target = join(workspace, path), label = JSON.stringify(path);
  if ((await lstat(target)).isSymbolicLink()) return `\n${label}: symbolic link (target not read)\n`;
  const within = relative(workspace, await realpath(target));
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new Error('Changed file is outside the worktree.');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384) return `\n${label}: preview unavailable (not a regular file or larger than 16 KiB)\n`;
    const buffer = Buffer.alloc(16385), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) return `\n${label}: preview unavailable (file grew during inspection)\n`;
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return `\n${label}: binary file\n`;
    const text = bytes.toString('utf8'), lines = text ? text.replace(/\n$/, '').split('\n') : [];
    return `\ndiff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\nnew file\n--- /dev/null\n+++ ${JSON.stringify(`b/${path}`)}\n@@ -0,0 +1,${lines.length} @@\n`
      + lines.map(line => `+${line}\n`).join('') + (text && !text.endsWith('\n') ? '\\ No newline at end of file\n' : '');
  } finally { await file.close(); }
}

/** Inspect retained files on the host. This never creates worktrees or wakes a worker. */
export function createWorkerWorkspaceInspection(options: { directory: string; openPath(path: string): Promise<string> }) {
  const workspaces = new WorkerWorkspaces(options.directory);
  return async (binding: Binding, taskId: string, action: 'inspect' | 'open'): Promise<WorkerWorkspaceInspection> => {
    const result: WorkerWorkspaceInspection = { state: 'unavailable', workspace: null, branch: null, baseCommit: null, baseBranch: null,
      kind: null, changes: [], diff: '', truncated: false, error: null, checkedAt: new Date().toISOString() };
    try {
      const saved = await workspaces.describeTask(binding, taskId);
      if (!saved) return { ...result, state: 'missing', error: 'No retained worktree is recorded for this task.' };
      Object.assign(result, saved);
      try { await lstat(saved.workspace); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return { ...result, state: 'missing', error: 'The recorded worktree folder has been removed.' };
      }
      await assertWorktree(join(workspaces.root(binding), 'worker-workspaces'), saved);
      if (action === 'open') {
        const error = await options.openPath(saved.workspace);
        if (error) return { ...result, error };
      }
      const [status, untracked, diff] = await Promise.all([
        git(saved.workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', saved.baseCommit, '--']),
        git(saved.workspace, ['ls-files', '--others', '--exclude-standard', '-z']),
        git(saved.workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', saved.baseCommit, '--']),
      ]);
      const records = status.split('\0').filter(Boolean);
      for (let i = 0; i < records.length; i += 2) result.changes.push({ status: records[i]!, path: records[i + 1]! });
      const added = untracked.split('\0').filter(Boolean);
      result.changes.push(...added.map(path => ({ path, status: '?' })));
      result.truncated = result.changes.length > 200 || diff.length > DIFF_LIMIT;
      result.changes = result.changes.slice(0, 200);
      result.diff = diff.slice(0, DIFF_LIMIT);
      for (const change of result.changes.filter(change => change.status === '?')) {
        if (result.diff.length >= DIFF_LIMIT) { result.truncated = true; break; }
        const patch = await untrackedPatch(saved.workspace, change.path);
        if (result.diff.length + patch.length > DIFF_LIMIT) result.truncated = true;
        result.diff += patch.slice(0, DIFF_LIMIT - result.diff.length);
      }
      return { ...result, state: 'ready' };
    } catch (error) {
      return { ...result, state: 'unavailable', error: (error instanceof Error ? error.message : 'Worktree inspection failed.').slice(0, 4096) };
    }
  };
}
