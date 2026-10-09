import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkerWorkspaces } from '../lib/agent-platform/worker-workspaces.mts';
import { git, revision } from '../lib/agent-platform/git-workspaces.mts';
import { assertFailure } from './agent-platform-fixtures.ts';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-worker-workspaces-')));
  const source = join(root, 'source'); mkdirSync(source);
  await git(source, ['init', '-b', 'main']);
  writeFileSync(join(source, 'file.txt'), 'committed');
  await git(source, ['add', '.']); await git(source, ['commit', '-m', '[test] fixture']);
  const directory = join(root, 'platform'), manager = new WorkerWorkspaces(directory);
  const binding = { workspace: source, engineId: 'docker:test', agentId: 'dev', accountId: 'default' };
  return { root, source, directory, manager, binding, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('Homies share a bare clone but retain independent dirty worktrees across follow-ups and restarts', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.source, 'file.txt'), 'user draft');
    const [first, concurrent] = await Promise.all([f.manager.ensure(f.binding), new WorkerWorkspaces(f.directory).ensure(f.binding)]);
    expect(concurrent).toEqual(first);
    expect(readFileSync(join(first.workspace, 'file.txt'), 'utf8')).toBe('committed');
    writeFileSync(join(first.workspace, 'file.txt'), 'Homie draft');
    writeFileSync(join(first.workspace, 'new.txt'), 'untracked follow-up');
    await git(f.source, ['add', '.']); await git(f.source, ['commit', '-m', '[test] advance source']);
    const second = await f.manager.ensure({ ...f.binding, agentId: 'reviewer' });
    const account = await f.manager.ensure({ ...f.binding, accountId: 'other' });
    expect(new Set([first.workspace, second.workspace, account.workspace]).size).toBe(3);
    expect(second.baseCommit).toBe(await revision(f.source, 'HEAD'));
    expect(readFileSync(join(second.workspace, 'file.txt'), 'utf8')).toBe('user draft');
    const reopened = await new WorkerWorkspaces(f.directory).ensure(f.binding);
    expect(reopened).toEqual(first);
    expect(readFileSync(join(reopened.workspace, 'file.txt'), 'utf8')).toBe('Homie draft');
    expect(readFileSync(join(reopened.workspace, 'new.txt'), 'utf8')).toBe('untracked follow-up');
    expect(existsSync(join(f.source, 'new.txt'))).toBe(false);
    const repository = join(dirname(first.workspace), 'repository');
    for (const workspace of [first, second, account]) {
      expect((await git(workspace.workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()).toBe(repository);
      expect(workspace.branch).toStartWith('worktree/feature/homie-');
    }
    expect(await git(f.source, ['status', '--porcelain'])).toBe('');
    expect(await git(f.source, ['branch', '--list', 'worktree/*'])).toBe('');
  } finally { f.dispose(); }
});

test('missing retained worktrees and repositories fail closed without recreating evidence', async () => {
  const f = await fixture();
  try {
    const saved = await f.manager.ensure(f.binding);
    renameSync(saved.workspace, `${saved.workspace}-retained`);
    await assertFailure(f.manager.ensure(f.binding), /ENOENT/);
    expect(existsSync(saved.workspace)).toBe(false);
    renameSync(`${saved.workspace}-retained`, saved.workspace);
    const repository = join(dirname(saved.workspace), 'repository');
    renameSync(repository, `${repository}-retained`);
    await assertFailure(f.manager.ensure({ ...f.binding, agentId: 'new' }), /missing but saved work/);
    expect(existsSync(repository)).toBe(false);
  } finally { f.dispose(); }
});

test('a changed branch cannot silently rebind a Homie to another workspace', async () => {
  const f = await fixture();
  try {
    const saved = await f.manager.ensure(f.binding);
    await git(saved.workspace, ['checkout', '-b', 'unexpected']);
    await assertFailure(f.manager.existing(f.binding), /identity changed/);
    await assertFailure(f.manager.ensure(f.binding), /identity changed/);
    expect((await git(saved.workspace, ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe('unexpected');
  } finally { f.dispose(); }
});
