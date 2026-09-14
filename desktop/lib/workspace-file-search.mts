import { opendir } from 'node:fs/promises';
import { workspaceFileSearchQuery, type WorkspaceFileSearchResult } from '../shared/workspace-file-search.ts';
import { openWorkspaceRoot, resolveWorkspaceTarget } from './workspace-file-paths.mts';

const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.build', 'build', 'dist', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', '.cache', '.turbo', 'target', '.venv', 'venv', '__pycache__',
]);
const RESULT_LIMIT = 100;

interface FileSearchOptions {
  maxEntries?: number;
  maxDurationMs?: number;
  cacheMs?: number;
  now?: () => number;
}

function comparePaths(left: string, right: string) {
  return left.localeCompare(right, 'en', { sensitivity: 'base' }) || left.localeCompare(right, 'en');
}

function matchRank(file: WorkspaceFileSearchResult['files'][number], query: string) {
  const name = file.name.toLowerCase();
  if (!query || name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return file.path.toLowerCase().includes(query) ? 3 : -1;
}

/** One short-lived inventory per workspace, shared by concurrent search requests. */
export function createWorkspaceFileSearch(workspaceRoot: string, {
  maxEntries = 50_000, maxDurationMs = 2_000, cacheMs = 5_000, now = Date.now,
}: FileSearchOptions = {}) {
  let cached: { value: WorkspaceFileSearchResult; expiresAt: number } | undefined;
  let pending: Promise<WorkspaceFileSearchResult> | undefined;

  async function scan(): Promise<WorkspaceFileSearchResult> {
    const root = await openWorkspaceRoot(workspaceRoot);
    const deadline = now() + maxDurationMs;
    const directories = [{ path: '', depth: 0 }];
    const files: WorkspaceFileSearchResult['files'] = [];
    let entriesSeen = 0;
    let truncated = false;
    for (let index = 0; index < directories.length; index += 1) {
      if (entriesSeen >= maxEntries || now() >= deadline) { truncated = true; break; }
      const directory = directories[index]!;
      try {
        // Revalidate each directory immediately before reading; never descend through symlinks.
        const absolute = await resolveWorkspaceTarget(root, directory.path);
        const entries = await opendir(absolute);
        for await (const entry of entries) {
          if (entriesSeen >= maxEntries || now() >= deadline) { truncated = true; break; }
          entriesSeen += 1;
          const relative = directory.path ? `${directory.path}/${entry.name}` : entry.name;
          if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
            if (directory.depth < 64) directories.push({ path: relative, depth: directory.depth + 1 });
            else truncated = true;
          } else if (entry.isFile()) files.push({ path: relative, name: entry.name });
        }
      } catch (error) {
        if (!directory.path) throw error;
        // A removed or inaccessible folder should not hide the rest of the workspace.
        truncated = true;
      }
    }
    files.sort((left, right) => comparePaths(left.path, right.path));
    return { files, truncated };
  }

  function inventory() {
    if (pending) return pending;
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);
    pending = scan().then(value => {
      cached = { value, expiresAt: now() + cacheMs };
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  }

  return async (value: unknown): Promise<WorkspaceFileSearchResult> => {
    const query = workspaceFileSearchQuery(value).toLowerCase();
    const snapshot = await inventory();
    const matches = snapshot.files.map(file => ({ file, rank: matchRank(file, query) }))
      .filter(match => match.rank >= 0)
      .sort((left, right) => left.rank - right.rank || comparePaths(left.file.path, right.file.path));
    return {
      files: matches.slice(0, RESULT_LIMIT).map(({ file }) => ({ ...file })),
      truncated: snapshot.truncated || matches.length > RESULT_LIMIT,
    };
  };
}
