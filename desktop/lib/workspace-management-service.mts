import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { GitHubRepositories, githubRepositoryName } from './github-repositories.mts';
import { readWorkspaceRegistry, registerWorkspace } from '../../config/workspace-storage.mts';
import type {
  WorkspaceCatalog,
  WorkspaceCatalogEntry,
  WorkspaceWorktree,
} from '../shared/workspace-management.ts';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const GIT_TIMEOUT_MS = 120_000;

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${label} must be a non-empty text value without control characters.`);
  }
  return value.trim();
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid workspace request.');
  }
  return value as Record<string, unknown>;
}

function absolutePath(value: unknown, label: string): string {
  const candidate = text(value, label);
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path.`);
  return path.resolve(candidate);
}

async function directory(value: unknown, label: string): Promise<string> {
  const candidate = absolutePath(value, label);
  const resolved = await realpath(candidate);
  if (!(await stat(resolved)).isDirectory()) throw new Error(`${label} is not a directory.`);
  return resolved;
}

function directoryName(value: unknown): string {
  const name = text(value, 'Directory name');
  if (name === '.' || name === '..' || /[/\\:]/u.test(name) || name.startsWith('-')) {
    throw new Error('Directory name must be a single new folder name.');
  }
  return name;
}

async function newDestination(parent: string, name: unknown): Promise<string> {
  const destination = path.join(parent, directoryName(name));
  let exists = false;
  try {
    await lstat(destination);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (exists) throw new Error('The destination already exists. Choose a new folder name.');
  return destination;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always',
      '-c', 'protocol.file.allow=always',
      ...args,
    ], {
      cwd,
      env: gitEnvironment(),
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('Git is not installed or is not available on PATH.'));
        return;
      }
      if (error.killed) {
        reject(new Error('Git timed out after two minutes. Check connectivity and authentication, then try again.'));
        return;
      }
      const detail = stderr.trim().slice(-4000);
      reject(new Error(detail || 'Git could not complete the workspace operation.'));
    });
  });
}

function cloneUrl(value: unknown): string {
  const candidate = text(value, 'Repository URL');
  if (candidate.startsWith('-') || candidate.includes('::')) throw new Error('Unsupported repository URL.');
  if (path.isAbsolute(candidate)) return candidate;
  if (/^(?:https|ssh|file):\/\//u.test(candidate)) {
    const parsed = new URL(candidate);
    if (parsed.password || (parsed.protocol === 'https:' && parsed.username)) {
      throw new Error('Do not include credentials in the repository URL. Use Git authentication.');
    }
    if (parsed.search || parsed.hash || !parsed.pathname || parsed.pathname === '/') {
      throw new Error('Repository URL must identify a repository without query parameters or fragments.');
    }
    if (parsed.protocol === 'file:' && parsed.hostname && parsed.hostname !== 'localhost') {
      throw new Error('File repository URLs must refer to this computer.');
    }
    return candidate;
  }
  if (/^(?:[\w.-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*:[^\s:]+$/u.test(candidate)) return candidate;
  throw new Error('Use an HTTPS or SSH repository URL, or an absolute local repository path.');
}

function refName(value: unknown, label: string): string {
  const ref = text(value, label);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(ref) || ref.includes('..') || ref.endsWith('/')) {
    throw new Error(`${label} must be a branch name, tag, or commit identifier.`);
  }
  return ref;
}

async function availableDirectory(rootPath: string): Promise<boolean> {
  try { return (await stat(rootPath)).isDirectory(); } catch { return false; }
}

async function isGitRepository(rootPath: string): Promise<boolean> {
  try { return (await git(rootPath, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'; }
  catch { return false; }
}

async function catalogEntry(entry: { id: string; name: string; rootPath: string }): Promise<WorkspaceCatalogEntry> {
  const available = await availableDirectory(entry.rootPath);
  return { ...entry, available, isGitRepository: available && await isGitRepository(entry.rootPath) };
}

async function register(dataRoot: string, rootPath: string): Promise<WorkspaceCatalogEntry> {
  const { id, name, rootPath: registeredPath } = registerWorkspace(dataRoot, rootPath);
  return catalogEntry({ id, name, rootPath: registeredPath });
}

export class WorkspaceManagementService {
  private readonly dataRoot: string;
  private mutating = false;
  private readonly github: GitHubRepositories;
  private readonly assertWorkspaceAvailable: (root: string) => void;

  constructor(dataRoot: string, github = new GitHubRepositories(), assertWorkspaceAvailable: (root: string) => void = () => {}) {
    this.dataRoot = absolutePath(dataRoot, 'Application data directory');
    this.github = github;
    this.assertWorkspaceAvailable = assertWorkspaceAvailable;
  }

  async list(): Promise<WorkspaceCatalog> {
    const registry = readWorkspaceRegistry(this.dataRoot);
    const workspaces = await Promise.all(registry.workspaces.map(({ id, name, rootPath }) => catalogEntry({ id, name, rootPath })));
    return { workspaces };
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mutating) throw new Error('Another workspace operation is in progress. Please wait.');
    this.mutating = true;
    try { return await operation(); } finally { this.mutating = false; }
  }

  async addFolder(value: unknown): Promise<WorkspaceCatalogEntry> {
    return this.mutate(async () => this.register(await directory(value, 'Workspace folder')));
  }

  async createProject(value: unknown): Promise<WorkspaceCatalogEntry> {
    return this.mutate(async () => {
      const request = requestRecord(value);
      const parent = await directory(request.parentPath, 'Parent folder');
      const destination = await newDestination(parent, request.directoryName);
      this.assertWorkspaceAvailable(destination);
      // mkdir is exclusive: a destination created after validation is never reused.
      await mkdir(destination);
      try {
        await git(destination, ['init', '--']);
      } catch (error) {
        // A failed initialization may leave files. Never recursively remove a folder
        // that an external editor or Git could have populated in the meantime.
        const removed = await rmdir(destination).then(() => true, () => false);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(removed ? detail : `${detail} The unfinished project folder was preserved at ${destination}.`);
      }
      try {
        return await this.register(await directory(destination, 'New project'));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`The project was created at ${destination}, but could not be added to Workspaces. Use Open folder to add it. ${detail}`);
      }
    });
  }

  private register(root: string): Promise<WorkspaceCatalogEntry> {
    this.assertWorkspaceAvailable(root);
    return register(this.dataRoot, root);
  }

  async clone(value: unknown): Promise<WorkspaceCatalogEntry> {
    return this.mutate(async () => {
      const request = requestRecord(value);
      const url = cloneUrl(request.url);
      const githubRepository = request.githubRepository === undefined ? undefined : githubRepositoryName(request.githubRepository);
      if (githubRepository !== undefined && url !== `https://github.com/${githubRepository}.git`) {
        throw new Error('The repository URL does not match the selected GitHub repository.');
      }
      const parent = await directory(request.parentPath, 'Parent folder');
      const destination = await newDestination(parent, request.directoryName);
      const args = ['clone'];
      if (request.depth !== undefined) {
        if (typeof request.depth !== 'number' || !Number.isSafeInteger(request.depth)
          || request.depth < 1 || request.depth > 1_000_000) {
          throw new Error('Clone depth must be an integer between 1 and 1000000.');
        }
        args.push('--depth', String(request.depth));
      }
      args.push('--', url, destination);
      if (githubRepository !== undefined) await this.github.clone(githubRepository, destination, parent, request.depth as number | undefined);
      else await git(parent, args);
      return this.register(await directory(destination, 'Cloned workspace'));
    });
  }

  async listWorktrees(value: unknown): Promise<WorkspaceWorktree[]> {
    const repositoryPath = await directory(value, 'Repository folder');
    const currentPath = (await git(repositoryPath, ['rev-parse', '--show-toplevel'])).trim();
    const output = await git(repositoryPath, ['worktree', 'list', '--porcelain', '-z']);
    return output.split('\0\0').filter(Boolean).map((record) => {
      const fields = record.split('\0');
      const worktreePath = fields.find((field) => field.startsWith('worktree '))?.slice(9);
      if (!worktreePath) throw new Error('Git returned an invalid worktree list.');
      const branchRef = fields.find((field) => field.startsWith('branch '))?.slice(7);
      return {
        path: worktreePath,
        branch: branchRef?.replace(/^refs\/heads\//u, '') ?? null,
        isCurrent: path.resolve(worktreePath) === path.resolve(currentPath),
        locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')),
        prunable: fields.some((field) => field === 'prunable' || field.startsWith('prunable ')),
      };
    });
  }

  async createWorktree(value: unknown): Promise<WorkspaceCatalogEntry> {
    return this.mutate(async () => {
      const request = requestRecord(value);
      const repository = await directory(request.repositoryPath, 'Repository folder');
      const root = (await git(repository, ['rev-parse', '--show-toplevel'])).trim();
      const destination = await newDestination(path.dirname(root), request.directoryName);
      const branch = refName(request.branch, 'New branch');
      const baseRef = refName(request.baseRef, 'Base reference');
      await git(repository, ['check-ref-format', '--branch', branch]);
      await git(repository, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]);
      await git(repository, ['worktree', 'add', '-b', branch, '--', destination, baseRef]);
      return this.register(await directory(destination, 'New worktree'));
    });
  }
}
