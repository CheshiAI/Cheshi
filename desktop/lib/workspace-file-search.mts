import { execFile } from 'node:child_process';
import { opendir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceRoot } from './workspace-file-types.mts';
import { openWorkspaceRoot, resolveWorkspaceTarget } from './workspace-file-paths.mts';
import { isSearchableWorkspacePath, workspaceFileSearchLimit, workspaceFileSearchQuery,
  type WorkspaceFileSearchResult } from '../shared/workspace-file-search.ts';

const execute = promisify(execFile);
const scanLimit = 50_000;

export async function listWorkspacePaths(root: WorkspaceRoot): Promise<{ paths: string[]; truncated: boolean }> {
  try {
    const { stdout } = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      { cwd: root.resolved, encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
    const paths = [...new Set(stdout.split('\0').filter(isSearchableWorkspacePath))];
    return { paths: paths.slice(0, scanLimit), truncated: paths.length > scanLimit };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code !== 'ENOENT' && !failure.stderr?.includes('not a git repository')) throw error;
  }
  // Non-Git workspaces need no index; walk directory entries without reading file contents.
  const paths: string[] = [];
  const directories = [''];
  let visited = 0;
  while (directories.length) {
    const relative = directories.pop()!;
    const target = await resolveWorkspaceTarget(root, relative || '.');
    const directory = await opendir(target);
    for await (const entry of directory) {
      if (++visited > scanLimit) return { paths, truncated: true };
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSearchableWorkspacePath(child) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) directories.push(child);
      else if (entry.isFile()) paths.push(child);
    }
  }
  return { paths, truncated: false };
}

function matchRank(filePath: string, query: string): number {
  const name = path.posix.basename(filePath).toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return filePath.toLowerCase().includes(query) ? 3 : -1;
}

export async function searchWorkspaceFiles(projectRoot: string, value: unknown): Promise<WorkspaceFileSearchResult> {
  const query = workspaceFileSearchQuery(value).toLowerCase();
  if (!query) return { files: [], truncated: false };
  const root = await openWorkspaceRoot(projectRoot);
  const listing = await listWorkspacePaths(root);
  const matches = listing.paths.map(filePath => ({ path: filePath, rank: matchRank(filePath, query) }))
    .filter(entry => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
  const files: WorkspaceFileSearchResult['files'] = [];
  for (const entry of matches) {
    try {
      const target = await resolveWorkspaceTarget(root, entry.path);
      if (!(await lstat(target)).isFile()) continue;
    } catch { continue; } // Deleted paths and symlinks cannot be opened by the workspace editor.
    if (files.length === workspaceFileSearchLimit) return { files, truncated: true };
    files.push({ path: entry.path, name: path.posix.basename(entry.path) });
  }
  return { files, truncated: listing.truncated };
}
