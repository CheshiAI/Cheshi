import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { commitId, inScope } from './contracts.mts';

export class GitConflict extends Error {
  readonly files: string[];
  constructor(files: string[]) { super(`Git conflict: ${files.join(', ')}`); this.files = files; }
}

export function git(directory: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Cheshi Agent Platform', GIT_AUTHOR_EMAIL: 'agent-platform@cheshi.invalid',
    GIT_COMMITTER_NAME: 'Cheshi Agent Platform', GIT_COMMITTER_EMAIL: 'agent-platform@cheshi.invalid' });
  return new Promise((accept, reject) => {
    execFile('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args],
    { cwd: directory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Git ${args[0]} failed: ${stderr.trim().slice(0, 2000) || error.message}`));
      else accept(stdout);
    });
  });
}

export function outside(repository: string, directory: string): void {
  const path = relative(repository, directory);
  if (path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path))) {
    throw new Error('Platform data must be outside the source repository.');
  }
}

export async function platformPaths(repository: string, directory: string): Promise<{ repository: string; directory: string }> {
  const source = await realpath(repository);
  if ((await realpath((await git(source, ['rev-parse', '--show-toplevel'])).trim())) !== source) throw new Error('Select the Git repository root.');
  const destination = resolve(directory);
  outside(source, destination);
  // Resolve an existing ancestor before creating anything, including through symlinked parents.
  let ancestor = destination;
  for (;;) {
    try { outside(source, await realpath(ancestor)); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const canonical = await realpath(destination); outside(source, canonical);
  return { repository: source, directory: canonical };
}

export function baseReference(value: string): string {
  if (!/^refs\/(?:heads|remotes)\/[a-zA-Z0-9_./-]+$/.test(value) || value.includes('..') || value.endsWith('/')) {
    throw new Error('Use a full local branch or remote-tracking reference.');
  }
  return value;
}

export async function revision(repository: string, ref: string): Promise<string> {
  return commitId((await git(repository, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim());
}

export async function mergeResult(directory: string, commit: string): Promise<string> {
  commitId(commit);
  try { await git(directory, ['merge', '--no-ff', '--no-edit', '--no-gpg-sign', commit]); }
  catch (error) {
    const conflicts = (await git(directory, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
    if (conflicts.length) throw new GitConflict(conflicts);
    throw error;
  }
  return revision(directory, 'HEAD');
}

export async function commitResult(directory: string, input: string, scope: string[], taskId: string, reason: string): Promise<string> {
  if (await revision(directory, 'HEAD') !== input) throw new Error('The worker changed Git history.');
  const changed = (await git(directory, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', input, '--'])).split('\0').filter(Boolean);
  const untracked = (await git(directory, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const paths = [...new Set([...changed, ...untracked])];
  if (!paths.length) throw new Error('The task produced no code changes.');
  const unexpected = paths.filter(path => !inScope(path, scope));
  if (unexpected.length) throw new Error(`Changes exceed the task scope: ${unexpected.join(', ')}`);
  await git(directory, ['add', '--all', '--', '.']);
  await git(directory, ['commit', '--no-gpg-sign', '-m', `[feature] complete agent task ${taskId}`, '-m', reason]);
  return revision(directory, 'HEAD');
}

export async function assertCleanCommit(directory: string, commit: string): Promise<void> {
  if (await revision(directory, 'HEAD') !== commit || (await git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'])).length) {
    throw new Error('The candidate workspace changed. Create a new candidate.');
  }
}
