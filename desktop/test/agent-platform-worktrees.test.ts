import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentPlatform } from '../lib/agent-platform/service.mts';
import { git, revision } from '../lib/agent-platform/git-workspaces.mts';
import { createWorktree, managedRepository, worktreeLocation } from '../lib/agent-platform/managed-worktrees.mts';
import { assertFailure, createDeferred, executor, fixture, plan, receipt, taskInput } from './agent-platform-fixtures.ts';

test('parallel tasks and integration share one clone while preserving dirty user checkouts', async () => {
  const bothEntered = createDeferred<void>(), release = createDeferred<void>();
  let entered = 0;
  const f = await fixture(executor(async request => {
    if (request.writable) {
      if (++entered === 2) bothEntered.resolve();
      await release.promise;
      expect(readFileSync(join(request.workspace, 'shared.txt'), 'utf8')).toBe('baseline\n');
      writeFileSync(join(request.workspace, `${request.command[0]}.txt`), 'implemented');
    }
    return receipt(request);
  }));
  try {
    const userWorktree = join(f.root, 'source-user-work');
    await git(f.repository, ['worktree', 'add', '-b', 'worktree/experiment/user-work', userWorktree, 'main']);
    writeFileSync(join(userWorktree, 'shared.txt'), 'user worktree edits');
    writeFileSync(join(f.repository, 'staged.txt'), 'staged user content');
    await git(f.repository, ['add', 'staged.txt']);
    writeFileSync(join(f.repository, 'shared.txt'), 'unstaged user edits');
    const originalStatus = await git(f.repository, ['status', '--porcelain=v1']);
    const originalRefs = await git(f.repository, ['show-ref']);
    const originalWorktrees = await git(f.repository, ['worktree', 'list', '--porcelain']);
    const repository = managedRepository(f.directory), inode = lstatSync(repository).ino;
    f.platform.enqueue(taskInput('alpha')); f.platform.enqueue(taskInput('beta'));
    const other = await AgentPlatform.open(f.options);
    const running = Promise.all([f.platform.runTask('alpha'), other.runTask('beta')]);
    await bothEntered.promise;
    const attempts = f.platform.snapshot().tasks.map(t => t.attempts[0]!);
    expect(new Set(attempts.map(a => a.branch)).size).toBe(2);
    for (const attempt of attempts) {
      expect(dirname(attempt.workspace)).toBe(dirname(repository));
      expect(lstatSync(join(attempt.workspace, '.git')).isFile()).toBe(true);
      expect((await git(attempt.workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()).toBe(repository);
      expect((await git(attempt.workspace, ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe(attempt.branch);
    }
    const indexes = await Promise.all(attempts.map(a => git(a.workspace, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])));
    expect(new Set(indexes).size).toBe(2);
    expect(existsSync(join(repository, 'objects', 'info', 'alternates'))).toBe(false);
    release.resolve();
    expect((await running).map(t => t.status)).toEqual(['succeeded', 'succeeded']);
    const candidate = await other.prepareCandidate(['alpha', 'beta'], [plan]);
    expect(candidate.branch).toStartWith('worktree/experiment/integration-');
    expect((await other.verifyCandidate(candidate.id)).status).toBe('passed');
    expect((await other.publication(candidate.id)).managedRepository).toBe(repository);
    expect(lstatSync(repository).ino).toBe(inode);
    expect((await git(repository, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(4);
    expect(await git(f.repository, ['status', '--porcelain=v1'])).toBe(originalStatus);
    expect(await git(f.repository, ['show-ref'])).toBe(originalRefs);
    expect(await git(f.repository, ['worktree', 'list', '--porcelain'])).toBe(originalWorktrees);
    expect(readFileSync(join(userWorktree, 'shared.txt'), 'utf8')).toBe('user worktree edits');
  } finally { release.resolve(); f.dispose(); }
});

test('a reopened platform imports a new source base without replacing its repository or old results', async () => {
  const f = await fixture(executor(async request => {
    writeFileSync(join(request.workspace, `${request.command[0]}.txt`), 'result'); return receipt(request);
  }));
  try {
    f.platform.enqueue(taskInput('before'));
    const before = (await f.platform.runTask('before')).attempts[0]!;
    const repository = managedRepository(f.directory), inode = lstatSync(repository).ino;
    await git(f.repository, ['commit', '--allow-empty', '-m', '[test] advance source']);
    const base = await revision(f.repository, 'HEAD');
    const reopened = await AgentPlatform.open(f.options);
    reopened.enqueue(taskInput('after'));
    const after = (await reopened.runTask('after')).attempts[0]!;
    expect(after.baseCommit).toBe(base); expect(after.inputCommit).toBe(base);
    expect(await revision(repository, `refs/heads/${before.branch}`)).toBe(before.resultCommit!);
    expect(await revision(repository, `refs/cheshi/bases/${base}`)).toBe(base);
    expect(lstatSync(repository).ino).toBe(inode);
  } finally { f.dispose(); }
});

test('failed worktrees remain intact when a retry receives its own branch and files', async () => {
  let fail = true;
  const f = await fixture(executor(async request => {
    writeFileSync(join(request.workspace, fail ? 'outside.txt' : 'bounded.txt'), fail ? 'failed evidence' : 'fixed');
    return receipt(request);
  }));
  try {
    f.platform.enqueue(taskInput('bounded'));
    const first = (await f.platform.runTask('bounded')).attempts[0]!;
    expect(first.status).toBe('failed');
    fail = false; f.platform.retry('bounded', 'Keep the change within scope');
    const retried = await f.platform.runTask('bounded'), second = retried.attempts[1]!;
    expect(retried.status).toBe('succeeded');
    expect(second.branch).not.toBe(first.branch); expect(second.workspace).not.toBe(first.workspace);
    expect(readFileSync(join(first.workspace, 'outside.txt'), 'utf8')).toBe('failed evidence');
    expect(existsSync(join(second.workspace, 'outside.txt'))).toBe(false);
    expect(await revision(first.workspace, 'HEAD')).toBe(first.inputCommit!);
  } finally { f.dispose(); }
});

test('legacy state is refused without rewriting its evidence', async () => {
  const f = await fixture(executor(async request => receipt(request)));
  try {
    const legacy = JSON.stringify({ ...f.platform.snapshot(), version: 1 });
    writeFileSync(join(f.directory, 'state.json'), legacy);
    await assertFailure(AgentPlatform.open(f.options), /Legacy clone-based.*new state directory/);
    expect(readFileSync(join(f.directory, 'state.json'), 'utf8')).toBe(legacy);
  } finally { f.dispose(); }
});

test('missing managed repositories with recorded attempts are never silently recreated', async () => {
  const f = await fixture(executor(async request => receipt(request)));
  try {
    f.platform.enqueue(taskInput('failed')); await f.platform.runTask('failed');
    const repository = managedRepository(f.directory);
    renameSync(repository, `${repository}-retained`);
    await assertFailure(AgentPlatform.open(f.options), /missing but saved work/);
    expect(existsSync(repository)).toBe(false);
    expect(existsSync(`${repository}-retained`)).toBe(true);
  } finally { f.dispose(); }
});

test('existing worktree paths and saved branch identities cannot be replaced', async () => {
  const f = await fixture(executor(async request => receipt(request)));
  try {
    const location = worktreeLocation(f.directory, 'task', 'retained');
    mkdirSync(location.workspace); writeFileSync(join(location.workspace, 'evidence'), 'keep');
    await assertFailure(createWorktree(f.directory, f.repository, await revision(f.repository, 'HEAD'), location), /already exists/);
    expect(readFileSync(join(location.workspace, 'evidence'), 'utf8')).toBe('keep');
    f.platform.enqueue(taskInput('failed')); await f.platform.runTask('failed');
    const saved = f.platform.snapshot(); saved.tasks[0]!.attempts[0]!.branch = 'main';
    writeFileSync(join(f.directory, 'state.json'), JSON.stringify(saved));
    expect(() => f.platform.snapshot()).toThrow('does not belong');
  } finally { f.dispose(); }
});

test('independent Node processes serialize first clone creation', async () => {
  const f = await fixture(executor(async request => receipt(request)));
  try {
    const directory = join(f.root, 'concurrent'); mkdirSync(directory);
    const moduleUrl = new URL('../lib/agent-platform/managed-worktrees.mts', import.meta.url).href;
    const code = `const {initializeRepository}=await import(${JSON.stringify(moduleUrl)});await initializeRepository(process.argv[1],process.argv[2],false);`;
    const initialize = () => new Promise<void>((resolve, reject) => {
      execFile('node', ['--input-type=module', '-e', code, directory, f.repository], { timeout: 10_000 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message)); else resolve();
      });
    });
    await Promise.all([initialize(), initialize()]);
    expect(readdirSync(directory)).toEqual(['repository']);
    expect(await revision(managedRepository(directory), 'main')).toBe(await revision(f.repository, 'main'));
  } finally { f.dispose(); }
});
