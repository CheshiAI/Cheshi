import { realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { gitLineBlame, gitLineBlameRequest, type GitLineBlame, type GitLineCommit } from '../shared/git-line-blame.ts';
import type { GitService } from './git-service.mts';

export function parseLineBlame(porcelain: string): GitLineBlame {
  const lines = porcelain.split('\n');
  const header = /^(\w+) (\d+) (\d+)(?: \d+)?$/u.exec(lines[0] ?? '');
  if (!header || !lines.some(line => line.startsWith('\t'))) throw new Error('Git returned incomplete line history.');
  if (/^0{40}(?:0{24})?$/u.test(header[1]!)) return { status: 'uncommitted' };
  const field = (name: string) => lines.find(line => line.startsWith(`${name} `))?.slice(name.length + 1);
  const seconds = Number(field('author-time'));
  const filename = field('filename');
  // With core.quotePath=false Git only quotes special characters, not UTF-8 bytes.
  const originalPath: unknown = filename?.startsWith('"') ? JSON.parse(filename) : filename;
  if (!Number.isFinite(seconds) || !Number.isFinite(new Date(seconds * 1000).getTime())) throw new Error('Invalid Git author date.');
  return gitLineBlame({ status: 'committed', hash: header[1], originalLine: Number(header[2]),
    author: field('author'), authoredAt: new Date(seconds * 1000).toISOString(), summary: field('summary'), originalPath });
}

/** Read-only blame of the editor buffer. Nothing is written to disk, the index, or a history database. */
export async function readGitLineBlame(service: Pick<GitService, 'workspaceRoot' | 'runGit'>, value: unknown): Promise<GitLineBlame> {
  const request = gitLineBlameRequest(value);
  const root = await realpath(service.workspaceRoot);
  let target: string;
  try { target = await realpath(resolve(root, request.path)); }
  catch { return { status: 'unavailable' }; }
  const local = relative(root, target);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || local.split(sep).includes('.git')) {
    throw new TypeError('Git line history requires a file within the workspace.');
  }
  const options = { acceptedExitCodes: [0, 1, 128], timeout: 5000, maxBytes: 128_000 };
  const head = await service.runGit(['rev-parse', '--verify', 'HEAD'], options);
  if (head.exitCode !== 0) return { status: 'unavailable' };
  // Check HEAD, not the index: a newly staged file still has no committing history.
  const tracked = await service.runGit(['--literal-pathspecs', 'ls-tree', '--name-only', 'HEAD', '--', request.path], options);
  if (tracked.exitCode !== 0 || tracked.truncated) return { status: 'unavailable' };
  if (!tracked.stdout.trim()) return { status: 'uncommitted' };
  // The empty visual line after a final newline has no corresponding Git line.
  if (!request.content || (request.content.endsWith('\n') && request.line === request.content.split('\n').length)) {
    return { status: 'uncommitted' };
  }
  const result = await service.runGit(['--no-pager', '-c', 'core.quotePath=false', 'blame', '--no-textconv',
    '--line-porcelain', '--contents', '-', '-L', `${request.line},${request.line}`, '--', request.path],
  { ...options, input: request.content });
  if (result.exitCode !== 0 || result.truncated) return { status: 'unavailable' };
  return parseLineBlame(result.stdout);
}

/** Resolve from the current buffer so stale hover metadata cannot open a different line's commit. */
export async function readGitLineCommit(service: Pick<GitService, 'workspaceRoot' | 'runGit'>, value: unknown): Promise<GitLineCommit> {
  const blame = await readGitLineBlame(service, value);
  if (blame.status !== 'committed') return blame;
  const [message, diff] = await Promise.all([
    service.runGit(['show', '--no-patch', '--format=%B', blame.hash], { maxBytes: 128_000, timeout: 5000 }),
    // Explicit first-parent diff also renders merge commits as ordinary unified patches.
    service.runGit(['-c', 'core.quotePath=false', 'show', '--format=', '--no-ext-diff', '--no-textconv',
      '--no-color', '--no-relative', '--find-renames', '--diff-merges=first-parent', '--root', blame.hash,
      '--', `:(top,literal)${blame.originalPath}`],
    { maxBytes: 4 * 1024 * 1024, timeout: 10_000 }),
  ]);
  return { status: 'committed', blame, message: message.stdout.trimEnd(), messageTruncated: message.truncated,
    patch: diff.stdout, truncated: diff.truncated };
}
