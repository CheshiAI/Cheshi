import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { GitService } from '../lib/git-service.mts';

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', '-C', directory, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createRepository(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-history-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, 'init', '-b', 'main');
  git(directory, 'config', 'user.name', 'Cheshi Test');
  git(directory, 'config', 'user.email', 'cheshi@example.test');
  writeFileSync(path.join(directory, 'shared.txt'), 'main version\n');
  git(directory, 'add', 'shared.txt');
  git(directory, 'commit', '-m', 'main commit');
  const mainHash = git(directory, 'rev-parse', 'HEAD').trim();
  git(directory, 'update-ref', 'refs/remotes/origin/main', mainHash);
  git(directory, 'switch', '-c', 'feature/history');
  writeFileSync(path.join(directory, 'shared.txt'), 'feature version\n');
  writeFileSync(path.join(directory, 'feature-only.txt'), 'feature file\n');
  git(directory, 'add', 'shared.txt', 'feature-only.txt');
  git(directory, 'commit', '-m', 'feature commit');
  const featureHash = git(directory, 'rev-parse', 'HEAD').trim();
  return { directory, mainHash, featureHash, service: new GitService({ workspaceRoot: directory }) };
}

function repositoryState(directory: string) {
  return {
    head: git(directory, 'rev-parse', 'HEAD'),
    branch: git(directory, 'branch', '--show-current'),
    status: git(directory, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    contents: ['shared.txt', 'feature-only.txt', 'untracked.txt', '.git/HEAD', '.git/index', '.git/logs/HEAD'].map((name) => {
      const filename = path.join(directory, name);
      return [name, existsSync(filename) ? readFileSync(filename) : null];
    }),
  };
}

for (const dirty of [false, true]) {
  test(`browses local and remote history without changing ${dirty ? 'dirty' : 'clean'} worktree or index`, async (t) => {
    const { directory, mainHash, featureHash, service } = createRepository(t);
    if (dirty) {
      writeFileSync(path.join(directory, 'shared.txt'), 'staged work\n');
      git(directory, 'add', 'shared.txt');
      writeFileSync(path.join(directory, 'shared.txt'), 'staged work\nunstaged work\n');
      writeFileSync(path.join(directory, 'untracked.txt'), 'new work\n');
    }
    const before = repositoryState(directory);
    const commands: string[][] = [];
    const runGit = service.runGit.bind(service);
    service.runGit = (args, options) => {
      commands.push([...args]);
      return runGit(args, options);
    };

    for (const reference of ['refs/heads/main', 'refs/remotes/origin/main']) {
      const commits = await service.getBranchCommits(reference);
      assert.deepEqual(commits.map((commit) => commit.hash), [mainHash]);
      const diff = await service.getDiff({ scope: 'commit', commit: commits[0]!.hash });
      assert.match(diff.patch, /\+main version/u);
      assert.deepEqual(repositoryState(directory), before);
    }
    const featureCommits = await service.getBranchCommits('refs/heads/feature/history');
    assert.deepEqual(featureCommits.map((commit) => commit.hash), [featureHash, mainHash]);
    assert.ok(commands.every(([command]) => ['show-ref', 'log', 'show'].includes(command!)));
    assert.deepEqual(repositoryState(directory), before);
  });
}

test('changes worktree files only after explicit checkout, while snapshot still describes actual HEAD', async (t) => {
  const { directory, mainHash, featureHash, service } = createRepository(t);
  await service.getBranchCommits('refs/heads/main');
  const snapshot = await service.getSnapshot();
  assert.ok(snapshot.available);
  assert.equal(snapshot.head, 'feature/history');
  assert.equal(snapshot.commits[0]?.hash, featureHash);
  assert.equal(readFileSync(path.join(directory, 'shared.txt'), 'utf8'), 'feature version\n');

  const checkedOut = await service.checkoutBranch('main');
  assert.ok(checkedOut.available);
  assert.equal(checkedOut.head, 'main');
  assert.equal(checkedOut.commits[0]?.hash, mainHash);
  assert.equal(readFileSync(path.join(directory, 'shared.txt'), 'utf8'), 'main version\n');
  assert.equal(existsSync(path.join(directory, 'feature-only.txt')), false);
});

test('rejects malformed, non-branch, missing, and deleted references without changing the repository', async (t) => {
  const { directory, service } = createRepository(t);
  git(directory, 'tag', 'release');
  git(directory, 'update-ref', '-d', 'refs/remotes/origin/main');
  const before = repositoryState(directory);
  const invalidReferences: unknown[] = [
    null, {}, '', '--all', 'main', 'HEAD', 'refs/tags/release',
    'refs/heads/main~1', 'refs/heads/missing', 'refs/remotes/origin/main',
  ];
  for (const reference of invalidReferences) {
    await assert.rejects(service.getBranchCommits(reference as string));
  }
  assert.deepEqual(repositoryState(directory), before);
});
