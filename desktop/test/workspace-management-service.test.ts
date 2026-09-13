import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readWorkspaceRegistry } from '../../config/workspace-storage.mts';
import { GitHubRepositories } from '../lib/github-repositories.mts';
import { WorkspaceManagementService } from '../lib/workspace-management-service.mts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cheshi-workspace-management-'));
  const repository = path.join(root, 'repository');
  const dataRoot = path.join(root, 'data');
  await mkdir(repository);
  git(repository, 'init', '-b', 'main');
  git(repository, 'config', 'user.name', 'Workspace Test');
  git(repository, 'config', 'user.email', 'workspace@example.invalid');
  await writeFile(path.join(repository, 'README.md'), '# Workspace fixture\n');
  git(repository, 'add', 'README.md');
  git(repository, 'commit', '-m', 'initial');
  return { root, repository, dataRoot, service: new WorkspaceManagementService(dataRoot) };
}

async function rejects(operation: Promise<unknown>, pattern?: RegExp): Promise<void> {
  let rejected = false;
  try { await operation; } catch (error) {
    rejected = true;
    assert.ok(error instanceof Error);
    if (pattern) assert.match(error.message, pattern);
  }
  assert.equal(rejected, true, 'Expected operation to reject');
}

test('registration persists, deduplicates canonical paths, and reports missing folders without indexing', async () => {
  const f = await fixture();
  try {
    const first = await f.service.addFolder(f.repository);
    assert.equal(first.isGitRepository, true);
    const again = await f.service.addFolder(path.join(f.repository, '.'));
    assert.equal(first.id, again.id);
    assert.deepEqual((await new WorkspaceManagementService(f.dataRoot).list()).workspaces, [first]);
    const registry = readWorkspaceRegistry(f.dataRoot);
    assert.equal(registry.currentWorkspaceId, null);
    assert.equal(existsSync(registry.workspaces[0]!.codeGraphPath), false);
    assert.equal(existsSync(path.join(f.repository, '.codegraph')), false);
    await rename(f.repository, path.join(f.root, 'moved'));
    assert.equal((await f.service.list()).workspaces[0]!.available, false);
    assert.equal((await f.service.list()).workspaces[0]!.isGitRepository, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('catalog detects Git worktrees and rechecks ordinary folders after Git initialization or removal', async () => {
  const f = await fixture();
  try {
    const plain = path.join(f.root, 'plain');
    await mkdir(plain);
    const registered = await f.service.addFolder(plain);
    assert.equal(registered.isGitRepository, false);
    git(plain, 'init', '-b', 'main');
    assert.equal((await f.service.list()).workspaces.find((entry) => entry.id === registered.id)?.isGitRepository, true);
    await rename(path.join(plain, '.git'), path.join(f.root, 'removed-git'));
    assert.equal((await f.service.list()).workspaces.find((entry) => entry.id === registered.id)?.isGitRepository, false);

    const linked = path.join(f.root, 'linked');
    git(f.repository, 'worktree', 'add', '-b', 'linked', linked);
    assert.match(await readFile(path.join(linked, '.git'), 'utf8'), /^gitdir:/);
    assert.equal((await f.service.addFolder(linked)).isGitRepository, true);
    const nested = path.join(linked, 'nested');
    await mkdir(nested);
    assert.equal((await f.service.addFolder(nested)).isGitRepository, true);

    const bare = path.join(f.root, 'bare');
    git(f.root, 'init', '--bare', bare);
    assert.equal((await f.service.addFolder(bare)).isGitRepository, false);
    await mkdir(path.join(plain, '.git'));
    assert.equal((await f.service.addFolder(plain)).isGitRepository, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('clones a local repository and registers only the completed repository', async () => {
  const f = await fixture();
  try {
    const result = await f.service.clone({ url: f.repository, parentPath: f.root, directoryName: 'clone' });
    assert.equal(result.rootPath, await realpath(path.join(f.root, 'clone')));
    assert.equal(result.isGitRepository, true);
    assert.equal(await readFile(path.join(result.rootPath, 'README.md'), 'utf8'), '# Workspace fixture\n');
    assert.equal(git(result.rootPath, 'rev-parse', 'HEAD'), git(f.repository, 'rev-parse', 'HEAD'));
    await rejects(f.service.clone({ url: path.join(f.root, 'absent'), parentPath: f.root, directoryName: 'failed' }));
    assert.equal((await f.service.list()).workspaces.length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preserves existing destinations and refuses escape paths, invalid inputs, and executable transports', async () => {
  const f = await fixture();
  try {
    const existing = path.join(f.root, 'existing');
    await mkdir(existing);
    await writeFile(path.join(existing, 'keep.txt'), 'keep');
    const request = { url: f.repository, parentPath: f.root, directoryName: 'existing' };
    await rejects(f.service.clone(request), /already exists/u);
    for (const directoryName of ['..', '../escape', 'nested/path', '-option', 'nested\\path']) {
      await rejects(f.service.clone({ ...request, directoryName }));
    }
    for (const url of ['ext::sh -c echo', '-c', 'http://example.com/repo', 'https://token@example.com/repo',
      'https://user:password@example.com/repo', 'ssh://git:password@example.com/repo', 'git://example.com/repo']) {
      await rejects(f.service.clone({ ...request, url, directoryName: 'new' }));
    }
    for (const depth of [0, -1, 1.5, '1', Infinity]) {
      await rejects(f.service.clone({ ...request, depth, directoryName: 'new' }));
    }
    for (const value of [null, true, [], '', 'relative', existing + '\0']) {
      await rejects(f.service.addFolder(value));
    }
    await rejects(f.service.addFolder(path.join(existing, 'keep.txt')));
    assert.equal(await readFile(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
    assert.deepEqual((await f.service.list()).workspaces, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('creates sibling worktrees from the requested base and lists branch and lock state', async () => {
  const f = await fixture();
  try {
    const initial = await f.service.listWorktrees(f.repository);
    assert.equal(initial.length, 1);
    assert.equal(initial[0]!.branch, 'main');
    assert.equal(initial[0]!.isCurrent, true);
    const result = await f.service.createWorktree({
      repositoryPath: f.repository, branch: 'worktree/feature/new-work', baseRef: 'main', directoryName: 'repository-new-work',
    });
    assert.equal(path.dirname(result.rootPath), path.dirname(initial[0]!.path));
    assert.equal(git(result.rootPath, 'branch', '--show-current'), 'worktree/feature/new-work');
    git(f.repository, 'worktree', 'lock', result.rootPath, '--reason', 'fixture');
    const worktrees = await f.service.listWorktrees(result.rootPath);
    const current = worktrees.find((worktree) => worktree.isCurrent)!;
    assert.equal(current.path, result.rootPath);
    assert.equal(current.locked, true);
    assert.equal(current.prunable, false);
    assert.equal(worktrees.find((worktree) => worktree.branch === 'main')!.isCurrent, false);
    assert.deepEqual((await f.service.list()).workspaces, [result]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('does not overwrite existing worktrees or branches and does not register invalid requests', async () => {
  const f = await fixture();
  try {
    const request = { repositoryPath: f.repository, branch: 'worktree/feature/new', baseRef: 'main', directoryName: 'new-worktree' };
    await rejects(f.service.createWorktree({ ...request, branch: 'main' }));
    await rejects(f.service.createWorktree({ ...request, baseRef: 'absent' }));
    await rejects(f.service.createWorktree({ ...request, branch: '-B' }));
    await rejects(f.service.createWorktree({ ...request, baseRef: '--all' }));
    await rejects(f.service.createWorktree({ ...request, directoryName: '../escape' }));
    await rejects(f.service.createWorktree({ ...request, directoryName: 'repository' }), /already exists/u);
    assert.equal(git(f.repository, 'branch', '--show-current'), 'main');
    assert.equal(git(f.repository, 'branch', '--list', 'worktree/feature/new'), '');
    assert.deepEqual((await f.service.list()).workspaces, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects concurrent mutations and releases the gate after failure', async () => {
  const f = await fixture();
  try {
    const first = f.service.addFolder(f.repository);
    await rejects(f.service.addFolder(f.repository), /in progress/u);
    await first;
    await rejects(f.service.clone(null));
    assert.equal((await f.service.addFolder(f.repository)).available, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test('selected GitHub repositories clone through gh and validate identity before any command', async () => {
  const f = await fixture();
  const calls: string[][] = [];
  const github = new GitHubRepositories(async (args) => {
    calls.push(args);
    await mkdir(args[3]!);
    return '';
  });
  const service = new WorkspaceManagementService(f.dataRoot, github);
  const request = {
    url: 'https://github.com/team/project.git', githubRepository: 'team/project',
    parentPath: f.root, directoryName: 'github-clone', depth: 5,
  };
  try {
    for (const patch of [{ githubRepository: '../project' }, { githubRepository: null },
      { url: 'https://github.com/other/project.git' }, { depth: '5' }, { directoryName: '../outside' }]) {
      await rejects(service.clone({ ...request, ...patch }));
    }
    assert.deepEqual(calls, []);
    const result = await service.clone(request);
    assert.equal(result.rootPath, await realpath(path.join(f.root, 'github-clone')));
    assert.deepEqual(calls[0], ['repo', 'clone', request.url, result.rootPath, '--no-upstream', '--', '--depth', '5']);
    await rejects(service.clone(request), /already exists/u);
    assert.equal(calls.length, 1);
    assert.equal((await service.list()).workspaces.length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed GitHub clone does not register an incomplete destination and permits retry', async () => {
  const f = await fixture();
  let fail = true;
  const github = new GitHubRepositories(async (args) => {
    if (fail) throw new Error('HTTP 401 private-output');
    await mkdir(args[3]!);
    return '';
  });
  const service = new WorkspaceManagementService(f.dataRoot, github);
  const request = { url: 'https://github.com/team/project.git', githubRepository: 'team/project',
    parentPath: f.root, directoryName: 'retry' };
  try {
    await rejects(service.clone(request), /Sign in/u);
    assert.deepEqual((await service.list()).workspaces, []);
    fail = false;
    assert.equal((await service.clone(request)).available, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('registration cannot restore a workspace entry while its folder is being deleted', async () => {
  const f = await fixture();
  try {
    let blocked = true;
    const service = new WorkspaceManagementService(f.dataRoot, undefined, () => {
      if (blocked) throw new Error('Workspace is being deleted');
    });
    await rejects(service.addFolder(f.repository), /being deleted/u);
    assert.deepEqual(readWorkspaceRegistry(f.dataRoot).workspaces, []);
    blocked = false;
    const entry = await service.addFolder(f.repository);
    assert.equal(readWorkspaceRegistry(f.dataRoot).workspaces[0]?.id, entry.id);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
