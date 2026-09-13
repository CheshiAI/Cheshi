import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { checkoutGitBranch } from '../frontend/src/features/git/gitBranchCheckout.ts';
import type { GitRepositorySnapshot } from '../frontend/src/cheshiDesktop.ts';
import { GitService } from '../lib/git-service.mts';

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function createRepository(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-checkout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, 'init', '-b', 'main');
  git(directory, 'config', 'user.name', 'Cheshi Test');
  git(directory, 'config', 'user.email', 'cheshi@example.test');
  writeFileSync(path.join(directory, 'alpha.txt'), 'original\n');
  writeFileSync(path.join(directory, '.gitignore'), 'ignored.txt\n');
  git(directory, 'add', 'alpha.txt', '.gitignore');
  git(directory, 'commit', '-m', 'initial commit');
  git(directory, 'branch', 'other');
  return { directory, service: new GitService({ workspaceRoot: directory }) };
}

function repositoryState(directory: string) {
  return {
    branch: git(directory, 'branch', '--show-current'),
    head: git(directory, 'rev-parse', 'HEAD'),
    status: git(directory, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    staged: git(directory, 'diff', '--cached'),
    working: git(directory, 'diff'),
    contents: ['alpha.txt', 'new.txt'].map((name) => {
      const filename = path.join(directory, name);
      return [name, existsSync(filename) ? readFileSync(filename, 'utf8') : null];
    }),
  };
}

const localChangeCases: Array<{ name: string; modify: (directory: string) => void }> = [
  {
    name: 'unstaged changes',
    modify: (directory) => writeFileSync(path.join(directory, 'alpha.txt'), 'work in progress\n'),
  },
  {
    name: 'staged changes',
    modify: (directory) => {
      writeFileSync(path.join(directory, 'alpha.txt'), 'staged work\n');
      git(directory, 'add', 'alpha.txt');
    },
  },
  {
    name: 'untracked files',
    modify: (directory) => writeFileSync(path.join(directory, 'new.txt'), 'new work\n'),
  },
  {
    name: 'deleted files',
    modify: (directory) => rmSync(path.join(directory, 'alpha.txt')),
  },
  {
    name: 'staged and unstaged changes in the same file',
    modify: (directory) => {
      writeFileSync(path.join(directory, 'alpha.txt'), 'staged work\n');
      git(directory, 'add', 'alpha.txt');
      writeFileSync(path.join(directory, 'alpha.txt'), 'staged work\nlater work\n');
    },
  },
];

for (const { name, modify } of localChangeCases) {
  test(`blocks ${name} before checkout IPC and before git switch`, async (t) => {
    const { directory, service } = createRepository(t);
    modify(directory);
    const before = repositoryState(directory);
    const checkoutRequests: string[] = [];
    const gitCommands: string[][] = [];
    const runGit = service.runGit.bind(service);
    service.runGit = (args, options) => {
      gitCommands.push([...args]);
      return runGit(args, options);
    };

    await assert.rejects(checkoutGitBranch({
      getGitSnapshot: () => service.getSnapshot(),
      checkoutGitBranch: (branch) => {
        checkoutRequests.push(branch);
        return service.checkoutBranch(branch);
      },
    }, 'other'), /Commit or discard local changes before switching branches\./);
    assert.deepEqual(checkoutRequests, []);

    await assert.rejects(service.checkoutBranch('other'), /Commit or discard local changes before switching branches\./);
    assert.equal(gitCommands.some((args) => args[0] === 'switch'), false);
    assert.deepEqual(repositoryState(directory), before);
  });
}

test('allows checkout after changes are committed and preserves ignored files', async (t) => {
  const { directory, service } = createRepository(t);
  writeFileSync(path.join(directory, 'alpha.txt'), 'finished work\n');
  git(directory, 'add', 'alpha.txt');
  git(directory, 'commit', '-m', 'finish work');
  writeFileSync(path.join(directory, 'ignored.txt'), 'local ignored content\n');

  const snapshot = await checkoutGitBranch({
    getGitSnapshot: () => service.getSnapshot(),
    checkoutGitBranch: (branch) => service.checkoutBranch(branch),
  }, 'other');

  assert.equal(snapshot.head, 'other');
  assert.deepEqual(snapshot.changes, []);
  assert.equal(readFileSync(path.join(directory, 'alpha.txt'), 'utf8'), 'original\n');
  assert.equal(readFileSync(path.join(directory, 'ignored.txt'), 'utf8'), 'local ignored content\n');
});

for (const snapshot of [
  { available: false, message: 'Git repository is unavailable.' },
  { available: true, message: '' },
  { available: 'true', message: '', changes: [] },
]) {
  test(`does not request checkout when current status cannot be verified: ${JSON.stringify(snapshot)}`, async () => {
    let checkoutRequests = 0;
    await assert.rejects(checkoutGitBranch({
      getGitSnapshot: async (): Promise<GitRepositorySnapshot> => snapshot as GitRepositorySnapshot,
      checkoutGitBranch: async () => {
        checkoutRequests += 1;
        return { available: true, message: '', changes: [] };
      },
    }, 'other'), /unavailable|Could not check local changes/);
    assert.equal(checkoutRequests, 0);
  });
}

test('does not request checkout when reading the latest status fails', async () => {
  let checkoutRequests = 0;
  await assert.rejects(checkoutGitBranch({
    getGitSnapshot: async () => { throw new Error('Cannot read repository status.'); },
    checkoutGitBranch: async () => {
      checkoutRequests += 1;
      return { available: true, message: '', changes: [] };
    },
  }, 'other'), /Cannot read repository status/);
  assert.equal(checkoutRequests, 0);
});
