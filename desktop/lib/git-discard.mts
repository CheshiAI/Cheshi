import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';

import {
  gitDiscardRequest,
  gitDiscardSelection,
  gitDiscardTarget,
  type GitDiscardFilePreview,
  type GitDiscardPreview,
  type GitDiscardTarget,
} from '../shared/git-discard.ts';
import { GitCommandError } from './git-command.mts';
import { parseStatus } from './git-parsers.mts';
import type { GitService } from './git-service.mts';
import type { CommandResult, GitFileChange } from './git-types.mts';

type DiscardService = Pick<GitService, 'workspaceRoot' | 'resolvePath' | 'runGit' | 'getSnapshot'>;
type TrashItem = (absolutePath: string) => Promise<void>;

interface DiscardPlan {
  preview: GitDiscardFilePreview;
  revision: string;
  paths: string[];
  head: string | null;
  trashPath: string | null;
}

const activeDiscards = new WeakSet<DiscardService>();

function completeOutput(result: CommandResult): string {
  if (result.truncated) throw new GitCommandError('Git file information was truncated. Discard was canceled.');
  return result.stdout;
}

async function fileStats(absolutePath: string) {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function validateFilePath(service: DiscardService, relativePath: string): Promise<string> {
  gitDiscardTarget({ path: relativePath, scope: 'working' });
  const { absolutePath } = service.resolvePath(relativePath);
  let parent = path.dirname(absolutePath);
  while (parent !== service.workspaceRoot) {
    const stats = await fileStats(parent);
    if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) {
      throw new GitCommandError('Discard cannot traverse a symbolic link or a non-directory parent.');
    }
    parent = path.dirname(parent);
  }
  return absolutePath;
}

async function fileFingerprint(absolutePath: string): Promise<string | null> {
  const before = await fileStats(absolutePath);
  if (!before) return null;
  if (before.isSymbolicLink()) return `link:${await readlink(absolutePath)}`;
  if (!before.isFile()) throw new GitCommandError('Discard changes supports individual files only.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  const after = await fileStats(absolutePath);
  if (
    !after || before.ino !== after.ino || before.dev !== after.dev
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs
  ) {
    throw new GitCommandError('The file changed while preparing the preview. Please try again.');
  }
  return `${before.mode}:${hash.digest('hex')}`;
}

function entryPaths(output: string): Set<string> {
  return new Set(output.split('\0').filter(Boolean).map((entry) => entry.slice(entry.indexOf('\t') + 1)));
}

function assertFileEntries(outputs: string[], paths: string[]): void {
  if (outputs.some((output) => (
    output.split('\0').some((entry) => entry.startsWith('040000 '))
    || [...entryPaths(output)].some((filePath) => !paths.includes(filePath))
  ))) {
    throw new GitCommandError('Discard changes supports individual files only. A directory replacement must be reviewed separately.');
  }
}

async function inspectDiscard(
  service: DiscardService, target: GitDiscardTarget, change: GitFileChange, head: string | null,
): Promise<DiscardPlan> {
  const absolutePath = await validateFilePath(service, target.path);
  const oldPath = target.scope === 'staged' && change.indexStatus === 'R' ? change.oldPath : null;
  const paths = oldPath ? [oldPath, target.path] : [target.path];
  const absolutePaths = await Promise.all(paths.map((filePath) => validateFilePath(service, filePath)));
  const [indexResult, treeResult] = await Promise.all([
    service.runGit(['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...paths]),
    head ? service.runGit(['--literal-pathspecs', 'ls-tree', '-z', head, '--', ...paths]) : null,
  ]);
  const index = completeOutput(indexResult);
  const tree = treeResult ? completeOutput(treeResult) : '';
  if (
    change.indexStatus === 'U' || change.workingTreeStatus === 'U'
    || index.split('\0').some((entry) => /^[^\t]+ [123]\t/u.test(entry))
  ) {
    throw new GitCommandError('Resolve this file’s merge conflict before discarding changes.');
  }
  if ([index, tree].some((output) => output.split('\0').some((entry) => entry.startsWith('160000 ')))) {
    throw new GitCommandError('Submodule changes must be managed inside the submodule.');
  }
  if (target.scope === 'staged') assertFileEntries([index, tree], paths);
  const fingerprints = await Promise.all(absolutePaths.map(fileFingerprint));
  if (oldPath && fingerprints[0] !== null) {
    throw new GitCommandError('The original rename path is occupied. Discard was canceled to preserve that file.');
  }
  const hasBaseFile = target.scope === 'working'
    ? entryPaths(index).has(target.path)
    : entryPaths(tree).has(target.path) || Boolean(oldPath);
  const action = hasBaseFile ? (target.scope === 'working' ? 'restore-index' : 'restore-head') : 'trash';
  const revision = createHash('sha256').update(JSON.stringify({
    target, change, index, head, tree, fingerprints,
  })).digest('hex');
  const currentFingerprint = fingerprints[fingerprints.length - 1];
  const trashPath = currentFingerprint != null && (
    action === 'trash' || (oldPath && !entryPaths(tree).has(target.path))
  ) ? absolutePath : null;
  return { preview: { ...target, oldPath, action }, revision, paths, head, trashPath };
}

async function inspectSelection(service: DiscardService, request: unknown) {
  const selection = gitDiscardSelection(request);
  // A path-filtered status loses the original path of staged renames.
  const [statusResult, headResult] = await Promise.all([
    service.runGit(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
    service.runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { acceptedExitCodes: [0, 1] }),
  ]);
  const changes = parseStatus(completeOutput(statusResult));
  const head = headResult.exitCode === 0 ? completeOutput(headResult).trim() : null;
  const plans: DiscardPlan[] = [];
  const paths = new Set<string>();
  for (const target of selection.targets) {
    const change = changes.find((item) => (
      item.path === target.path && (target.scope === 'staged' ? item.staged : item.unstaged)
    ));
    if (!change) {
      throw new GitCommandError('A selected file no longer has those changes. Refresh the file list.');
    }
    const plan = await inspectDiscard(service, target, change, head);
    for (const filePath of plan.paths) {
      if (paths.has(filePath)) throw new GitCommandError('Selected rename paths overlap. Review those files separately.');
      paths.add(filePath);
    }
    plans.push(plan);
  }
  const revision = createHash('sha256').update(JSON.stringify(plans.map((plan) => plan.revision))).digest('hex');
  return { plans, preview: { files: plans.map((plan) => plan.preview), revision } };
}

export async function prepareGitDiscard(service: DiscardService, request: unknown): Promise<GitDiscardPreview> {
  return (await inspectSelection(service, request)).preview;
}

function assertDiscardRevision(actual: string | undefined, expected: string): void {
  if (actual !== expected) {
    throw new GitCommandError('A selected file or its staged changes changed after the preview. Review the files again before discarding.');
  }
}

async function applyDiscard(service: DiscardService, plan: DiscardPlan, trashItem: TrashItem): Promise<void> {
  if (plan.trashPath) await trashItem(plan.trashPath);
  try {
    if (plan.preview.action === 'restore-index') {
      await service.runGit(['--literal-pathspecs', 'restore', '--worktree', '--', plan.preview.path]);
    } else if (plan.preview.action === 'restore-head') {
      await service.runGit([
        '--literal-pathspecs', 'restore', `--source=${plan.head}`, '--staged', '--worktree', '--', ...plan.paths,
      ]);
    } else if (plan.preview.scope === 'staged') {
      await service.runGit(['--literal-pathspecs', 'rm', '--cached', '--force', '--', plan.preview.path]);
    }
  } catch (error) {
    if (plan.trashPath) {
      throw new GitCommandError(`The file was moved to Trash, but Git could not finish: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
}

export async function discardGitFileChanges(service: DiscardService, value: unknown, trashItem: TrashItem) {
  const request = gitDiscardRequest(value);
  if (activeDiscards.has(service)) throw new GitCommandError('Another discard is still running.');
  activeDiscards.add(service);
  try {
    const { plans, preview } = await inspectSelection(service, request);
    assertDiscardRevision(preview.revision, request.expectedRevision);
    let completed = 0;
    for (const plan of plans) {
      try {
        const current = await inspectSelection(service, { targets: [plan.preview] });
        assertDiscardRevision(current.plans[0]?.revision, plan.revision);
        await applyDiscard(service, plan, trashItem);
        completed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new GitCommandError(`Could not discard ${plan.preview.path}. ${completed} file(s) already completed. ${message}`);
      }
    }
    return await service.getSnapshot();
  } finally {
    activeDiscards.delete(service);
  }
}
