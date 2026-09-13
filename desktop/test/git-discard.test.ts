import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  symlinkSync as createSymbolicLink, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { checkedGitDiscardTargets, selectGitChanges } from '../frontend/src/features/git/gitChangeSelection.ts';
import { GitService } from '../lib/git-service.mts';
import type { GitSnapshot } from '../lib/git-types.mts';
import {
  gitDiscardRequest, gitDiscardSelection, type GitDiscardTarget,
} from '../shared/git-discard.ts';

function runGit(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '--literal-pathspecs', ...args], { encoding: 'utf8' });
}

function createRepository(t: TestContext, initialCommit = true) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-discard-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const root = path.join(fixtureRoot, 'repo');
  const trashRoot = path.join(fixtureRoot, 'trash');
  mkdirSync(root);
  mkdirSync(trashRoot);
  runGit(root, 'init', '-b', 'main');
  runGit(root, 'config', 'user.name', 'Cheshi Test');
  runGit(root, 'config', 'user.email', 'cheshi@example.test');
  runGit(root, 'config', 'commit.gpgsign', 'false');
  const write = (filePath: string, content: string): void => {
    writeFileSync(path.join(root, filePath), content);
  };
  const read = (filePath: string): string => readFileSync(path.join(root, filePath), 'utf8');
  if (initialCommit) {
    for (const name of ['alpha', 'beta', 'gamma']) write(`${name}.txt`, `${name} base\n`);
    runGit(root, 'add', '.');
    runGit(root, 'commit', '-m', 'initial');
  }
  const service = new GitService({ workspaceRoot: root });
  const trashed: { from: string; to: string }[] = [];
  const trashItem = async (absolutePath: string): Promise<void> => {
    assert.equal(path.dirname(absolutePath), root);
    const destination = path.join(trashRoot, String(trashed.length));
    renameSync(absolutePath, destination);
    trashed.push({ from: absolutePath, to: destination });
  };
  const prepare = async (targets: GitDiscardTarget[]) => {
    const preview = await service.prepareDiscard({ targets });
    return {
      targets: preview.files.map(({ path, scope }) => ({ path, scope })),
      expectedRevision: preview.revision,
      confirmed: true as const,
    };
  };
  const discard = async (targets: GitDiscardTarget[]) => service.discardChanges(await prepare(targets), trashItem);
  return { root, fixtureRoot, service, write, read, trashed, trashItem, prepare, discard };
}

function checkedDiscardTargets(snapshot: GitSnapshot): GitDiscardTarget[] {
  assert.equal(snapshot.available, true);
  return checkedGitDiscardTargets(snapshot.changes);
}

test('previews and discards all checked files while preserving unchecked changes', async (t) => {
  const repo = createRepository(t);
  for (const name of ['alpha', 'beta', 'gamma']) repo.write(`${name}.txt`, `${name} keep\n`);
  repo.write('unchecked.txt', 'unchecked new file\n');
  const checkedPaths = ['checked-one.txt', 'checked-two.txt'];
  for (const filePath of checkedPaths) repo.write(filePath, `${filePath} recoverable\n`);
  const snapshot = await repo.service.stagePaths(checkedPaths);
  const targets = checkedDiscardTargets(snapshot);
  assert.deepEqual(targets, checkedPaths.map((filePath) => ({ path: filePath, scope: 'staged' })));
  const before = runGit(repo.root, 'status', '--porcelain=v1');
  const preview = await repo.service.prepareDiscard({ targets });
  assert.deepEqual(preview.files.map((file) => file.path), checkedPaths);
  assert.equal(runGit(repo.root, 'status', '--porcelain=v1'), before);
  assert.equal(repo.trashed.length, 0);
  await repo.service.discardChanges({ targets, expectedRevision: preview.revision, confirmed: true }, repo.trashItem);
  for (const name of ['alpha', 'beta', 'gamma']) assert.equal(repo.read(`${name}.txt`), `${name} keep\n`);
  assert.equal(repo.read('unchecked.txt'), 'unchecked new file\n');
  assert.equal(repo.trashed.length, checkedPaths.length);
  for (const [index, filePath] of checkedPaths.entries()) {
    assert.equal(existsSync(path.join(repo.root, filePath)), false);
    assert.equal(readFileSync(repo.trashed[index]!.to, 'utf8'), `${filePath} recoverable\n`);
  }
  assert.equal(runGit(repo.root, 'diff', '--cached'), '');
});

test('updates checked discard targets after unchecking files even when unstaged edits remain', async (t) => {
  const repo = createRepository(t);
  repo.write('alpha.txt', 'alpha staged\n');
  repo.write('beta.txt', 'beta staged\n');
  await repo.service.stagePaths(['alpha.txt', 'beta.txt']);
  repo.write('alpha.txt', 'alpha unstaged\n');
  const snapshot = await repo.service.getSnapshot();
  assert.deepEqual(checkedDiscardTargets(snapshot), [
    { path: 'alpha.txt', scope: 'staged' },
    { path: 'beta.txt', scope: 'staged' },
  ]);
  const oneChecked = await repo.service.unstagePaths(['alpha.txt']);
  assert.deepEqual(checkedDiscardTargets(oneChecked), [{ path: 'beta.txt', scope: 'staged' }]);
  const noneChecked = await repo.service.unstagePaths(['beta.txt']);
  assert.deepEqual(checkedDiscardTargets(noneChecked), []);
  assert.equal(repo.read('alpha.txt'), 'alpha unstaged\n');
  assert.equal(repo.read('beta.txt'), 'beta staged\n');
});

test('previews without changes and discards only the selected unstaged file against the index', async (t) => {
  const repo = createRepository(t);
  repo.write('alpha.txt', 'alpha staged\n');
  runGit(repo.root, 'add', 'alpha.txt');
  repo.write('alpha.txt', 'alpha unstaged\n');
  repo.write('beta.txt', 'beta keep\n');
  const statusBefore = runGit(repo.root, 'status', '--porcelain=v1');
  const request = await repo.prepare([{ path: 'alpha.txt', scope: 'working' }]);
  assert.equal(repo.read('alpha.txt'), 'alpha unstaged\n');
  assert.equal(runGit(repo.root, 'status', '--porcelain=v1'), statusBefore);
  await repo.service.discardChanges(request, repo.trashItem);
  assert.equal(repo.read('alpha.txt'), 'alpha staged\n');
  assert.equal(runGit(repo.root, 'show', ':alpha.txt'), 'alpha staged\n');
  assert.equal(repo.read('beta.txt'), 'beta keep\n');
  assert.deepEqual(repo.trashed, []);
});

test('discards selected staged and unstaged changes against HEAD while preserving other files', async (t) => {
  const repo = createRepository(t);
  repo.write('alpha.txt', 'alpha staged\n');
  repo.write('beta.txt', 'beta staged\n');
  runGit(repo.root, 'add', 'alpha.txt', 'beta.txt');
  repo.write('alpha.txt', 'alpha unstaged\n');
  repo.write('beta.txt', 'beta unstaged\n');
  await repo.discard([{ path: 'alpha.txt', scope: 'staged' }]);
  assert.equal(repo.read('alpha.txt'), 'alpha base\n');
  assert.equal(runGit(repo.root, 'show', ':alpha.txt'), 'alpha base\n');
  assert.equal(repo.read('beta.txt'), 'beta unstaged\n');
  assert.equal(runGit(repo.root, 'show', ':beta.txt'), 'beta staged\n');
});

test('discards multiple selected files in one request and keeps unselected changes', async (t) => {
  const repo = createRepository(t);
  for (const name of ['alpha', 'beta', 'gamma']) repo.write(`${name}.txt`, `${name} changed\n`);
  const snapshot = await repo.discard([
    { path: 'alpha.txt', scope: 'working' },
    { path: 'beta.txt', scope: 'working' },
  ]);
  assert.equal(repo.read('alpha.txt'), 'alpha base\n');
  assert.equal(repo.read('beta.txt'), 'beta base\n');
  assert.equal(repo.read('gamma.txt'), 'gamma changed\n');
  assert.equal(snapshot.available, true);
  if (snapshot.available) assert.deepEqual(snapshot.changes.map((file) => file.path), ['gamma.txt']);
});

test('revalidates the entire batch before changing any file', async (t) => {
  const repo = createRepository(t);
  repo.write('alpha.txt', 'alpha changed\n');
  repo.write('beta.txt', 'beta changed\n');
  const request = await repo.prepare([
    { path: 'alpha.txt', scope: 'working' },
    { path: 'beta.txt', scope: 'working' },
  ]);
  repo.write('beta.txt', 'beta edited after preview\n');
  await assert.rejects(repo.service.discardChanges(request, repo.trashItem), /changed after the preview/u);
  assert.equal(repo.read('alpha.txt'), 'alpha changed\n');
  assert.equal(repo.read('beta.txt'), 'beta edited after preview\n');
  assert.deepEqual(repo.trashed, []);
});

test('rejects changed staging after confirmation preview', async (t) => {
  const repo = createRepository(t);
  repo.write('alpha.txt', 'first stage\n');
  runGit(repo.root, 'add', 'alpha.txt');
  const request = await repo.prepare([{ path: 'alpha.txt', scope: 'staged' }]);
  repo.write('alpha.txt', 'new stage\n');
  runGit(repo.root, 'add', 'alpha.txt');
  await assert.rejects(repo.service.discardChanges(request, repo.trashItem), /changed after the preview/u);
  assert.equal(repo.read('alpha.txt'), 'new stage\n');
  assert.equal(runGit(repo.root, 'show', ':alpha.txt'), 'new stage\n');
});

test('allows unrelated edits after the selected file preview', async (t) => {
  const repo = createRepository(t);
  repo.write('alpha.txt', 'alpha changed\n');
  const request = await repo.prepare([{ path: 'alpha.txt', scope: 'working' }]);
  repo.write('beta.txt', 'beta edited later\n');
  await repo.service.discardChanges(request, repo.trashItem);
  assert.equal(repo.read('alpha.txt'), 'alpha base\n');
  assert.equal(repo.read('beta.txt'), 'beta edited later\n');
});

test('moves only the selected untracked file to Trash', async (t) => {
  const repo = createRepository(t);
  repo.write('new.txt', 'recoverable content\n');
  repo.write('keep.txt', 'keep new file\n');
  await repo.discard([{ path: 'new.txt', scope: 'working' }]);
  assert.equal(existsSync(path.join(repo.root, 'new.txt')), false);
  assert.equal(repo.read('keep.txt'), 'keep new file\n');
  assert.equal(repo.trashed.length, 1);
  assert.equal(readFileSync(repo.trashed[0]!.to, 'utf8'), 'recoverable content\n');
});

for (const initialCommit of [true, false]) {
  test(`discards a staged new file with ${initialCommit ? 'an existing' : 'an unborn'} HEAD`, async (t) => {
    const repo = createRepository(t, initialCommit);
    repo.write('new.txt', 'staged new content\n');
    runGit(repo.root, 'add', 'new.txt');
    await repo.discard([{ path: 'new.txt', scope: 'staged' }]);
    assert.equal(existsSync(path.join(repo.root, 'new.txt')), false);
    assert.equal(runGit(repo.root, 'ls-files', '--', 'new.txt'), '');
    assert.equal(readFileSync(repo.trashed[0]!.to, 'utf8'), 'staged new content\n');
  });
}

test('restores a deleted tracked file without changing another deletion', async (t) => {
  const repo = createRepository(t);
  rmSync(path.join(repo.root, 'alpha.txt'));
  rmSync(path.join(repo.root, 'beta.txt'));
  await repo.discard([{ path: 'alpha.txt', scope: 'working' }]);
  assert.equal(repo.read('alpha.txt'), 'alpha base\n');
  assert.equal(existsSync(path.join(repo.root, 'beta.txt')), false);
});

test('restores a staged deletion when an untracked replacement has the same path', async (t) => {
  const repo = createRepository(t);
  runGit(repo.root, 'rm', 'alpha.txt');
  repo.write('alpha.txt', 'untracked replacement\n');
  repo.write('beta.txt', 'beta keep\n');
  const preview = await repo.service.prepareDiscard({ targets: [{ path: 'alpha.txt', scope: 'staged' }] });
  assert.deepEqual(preview.files, [{ path: 'alpha.txt', scope: 'staged', oldPath: null, action: 'restore-head' }]);
  await repo.discard([{ path: 'alpha.txt', scope: 'staged' }]);
  assert.equal(repo.read('alpha.txt'), 'alpha base\n');
  assert.equal(runGit(repo.root, 'show', ':alpha.txt'), 'alpha base\n');
  assert.equal(repo.read('beta.txt'), 'beta keep\n');
});

test('rejects a directory replaced by a file without restoring unselected descendants', async (t) => {
  const repo = createRepository(t);
  mkdirSync(path.join(repo.root, 'folder'));
  repo.write('folder/child.txt', 'child base\n');
  runGit(repo.root, 'add', 'folder/child.txt');
  runGit(repo.root, 'commit', '-m', 'nested file');
  renameSync(path.join(repo.root, 'folder'), path.join(repo.fixtureRoot, 'old-folder'));
  repo.write('folder', 'replacement file\n');
  runGit(repo.root, 'add', '-A', '--', 'folder');
  const index = runGit(repo.root, 'ls-files', '--stage');
  await assert.rejects(repo.prepare([{ path: 'folder', scope: 'staged' }]), /directory|individual files/u);
  assert.equal(repo.read('folder'), 'replacement file\n');
  assert.equal(runGit(repo.root, 'ls-files', '--stage'), index);
});

test('preserves a later file edited while an earlier file is being discarded', async (t) => {
  const repo = createRepository(t);
  repo.write('new.txt', 'first file\n');
  repo.write('alpha.txt', 'alpha changed\n');
  const request = await repo.prepare([
    { path: 'new.txt', scope: 'working' },
    { path: 'alpha.txt', scope: 'working' },
  ]);
  await assert.rejects(repo.service.discardChanges(request, async (absolutePath: string) => {
    await repo.trashItem(absolutePath);
    repo.write('alpha.txt', 'edited during discard\n');
  }), /changed/u);
  assert.equal(repo.read('alpha.txt'), 'edited during discard\n');
  assert.equal(repo.trashed.length, 1);
});

test('restores the original staged rename path and preserves the renamed content in Trash', async (t) => {
  const repo = createRepository(t);
  runGit(repo.root, 'mv', 'alpha.txt', 'renamed.txt');
  repo.write('renamed.txt', 'renamed content\n');
  repo.write('beta.txt', 'beta keep\n');
  const preview = await repo.service.prepareDiscard({ targets: [{ path: 'renamed.txt', scope: 'staged' }] });
  assert.deepEqual(preview.files, [{ path: 'renamed.txt', scope: 'staged', oldPath: 'alpha.txt', action: 'restore-head' }]);
  await repo.discard([{ path: 'renamed.txt', scope: 'staged' }]);
  assert.equal(repo.read('alpha.txt'), 'alpha base\n');
  assert.equal(existsSync(path.join(repo.root, 'renamed.txt')), false);
  assert.equal(runGit(repo.root, 'diff', '--cached'), '');
  assert.equal(repo.read('beta.txt'), 'beta keep\n');
  assert.equal(readFileSync(repo.trashed[0]!.to, 'utf8'), 'renamed content\n');
});

test('preserves another file occupying the original rename path', async (t) => {
  const repo = createRepository(t);
  runGit(repo.root, 'mv', 'alpha.txt', 'renamed.txt');
  repo.write('alpha.txt', 'new occupant\n');
  await assert.rejects(repo.prepare([{ path: 'renamed.txt', scope: 'staged' }]), /original rename path is occupied/u);
  assert.equal(repo.read('alpha.txt'), 'new occupant\n');
  assert.equal(repo.read('renamed.txt'), 'alpha base\n');
});

test('uses literal paths including wildcard characters, pathspec magic, and surrounding spaces', async (t) => {
  const repo = createRepository(t);
  const names = ['star*.txt', ':(glob)*.txt', ' surrounded .txt '];
  for (const name of names) repo.write(name, `${name} base\n`);
  runGit(repo.root, 'add', '--', ...names);
  runGit(repo.root, 'commit', '-m', 'unusual names');
  for (const name of names) repo.write(name, `${name} changed\n`);
  repo.write('alpha.txt', 'alpha keep\n');
  await repo.discard(names.map((filePath) => ({ path: filePath, scope: 'working' })));
  for (const name of names) assert.equal(repo.read(name), `${name} base\n`);
  assert.equal(repo.read('alpha.txt'), 'alpha keep\n');
});

test('rejects directories and symlink parents without touching their contents', async (t) => {
  const repo = createRepository(t);
  const outside = path.join(repo.fixtureRoot, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'keep.txt'), 'outside content\n');
  mkdirSync(path.join(repo.root, 'linked'));
  repo.write('linked/keep.txt', 'tracked content\n');
  runGit(repo.root, 'add', 'linked/keep.txt');
  runGit(repo.root, 'commit', '-m', 'nested file');
  renameSync(path.join(repo.root, 'linked'), path.join(repo.fixtureRoot, 'old-linked'));
  createSymbolicLink(outside, path.join(repo.root, 'linked'));
  mkdirSync(path.join(repo.root, 'folder'));
  repo.write('folder/new.txt', 'nested content\n');
  await assert.rejects(repo.prepare([{ path: 'folder', scope: 'working' }]), /no longer|individual files/u);
  await assert.rejects(repo.prepare([{ path: 'linked/keep.txt', scope: 'working' }]), /symbolic link/u);
  assert.equal(readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside content\n');
  assert.equal(repo.read('folder/new.txt'), 'nested content\n');
});

test('reports completed files when Trash fails and allows the remaining file to be retried', async (t) => {
  const repo = createRepository(t);
  repo.write('alpha.txt', 'alpha changed\n');
  repo.write('new.txt', 'new content\n');
  repo.write('beta.txt', 'beta keep\n');
  const request = await repo.prepare([
    { path: 'alpha.txt', scope: 'working' },
    { path: 'new.txt', scope: 'working' },
  ]);
  await assert.rejects(repo.service.discardChanges(request, async () => {
    throw new Error('Trash unavailable.');
  }), /new.txt. 1 file\(s\) already completed. Trash unavailable/u);
  assert.equal(repo.read('alpha.txt'), 'alpha base\n');
  assert.equal(repo.read('new.txt'), 'new content\n');
  assert.equal(repo.read('beta.txt'), 'beta keep\n');
  await repo.discard([{ path: 'new.txt', scope: 'working' }]);
  assert.equal(readFileSync(repo.trashed[0]!.to, 'utf8'), 'new content\n');
});

test('rejects merge conflicts before writing any selected file', async (t) => {
  const repo = createRepository(t);
  const objectId = runGit(repo.root, 'rev-parse', 'HEAD:alpha.txt').trim();
  execFileSync('git', ['-C', repo.root, 'update-index', '--index-info'], {
    input: `0 ${'0'.repeat(objectId.length)}\talpha.txt\n100644 ${objectId} 1\talpha.txt\n100644 ${objectId} 2\talpha.txt\n100644 ${objectId} 3\talpha.txt\n`,
  });
  repo.write('beta.txt', 'beta keep\n');
  await assert.rejects(repo.prepare([
    { path: 'beta.txt', scope: 'working' },
    { path: 'alpha.txt', scope: 'staged' },
  ]), /merge conflict/u);
  assert.equal(repo.read('beta.txt'), 'beta keep\n');
  assert.notEqual(runGit(repo.root, 'ls-files', '--unmerged'), '');
});

test('deduplicates both scopes of one file using the explicit staged discard preview', async (t) => {
  const repo = createRepository(t);
  repo.write('alpha.txt', 'staged\n');
  runGit(repo.root, 'add', 'alpha.txt');
  repo.write('alpha.txt', 'unstaged\n');
  const preview = await repo.service.prepareDiscard({ targets: [
    { path: 'alpha.txt', scope: 'working' },
    { path: 'alpha.txt', scope: 'staged' },
  ] });
  assert.deepEqual(preview.files, [{ path: 'alpha.txt', scope: 'staged', oldPath: null, action: 'restore-head' }]);
  await repo.service.discardChanges({
    targets: preview.files, expectedRevision: preview.revision, confirmed: true,
  }, repo.trashItem);
  assert.equal(repo.read('alpha.txt'), 'alpha base\n');
});

test('requires explicit confirmation, a preview revision, and exact workspace file paths', () => {
  const valid = { targets: [{ path: 'alpha.txt', scope: 'working' }], expectedRevision: 'a'.repeat(64), confirmed: true };
  for (const confirmed of [false, 1, 'true', undefined]) {
    assert.throws(() => gitDiscardRequest({ ...valid, confirmed }), /Confirm/u);
  }
  assert.throws(() => gitDiscardRequest({ ...valid, expectedRevision: '' }), /preview/u);
  assert.throws(() => gitDiscardSelection({ targets: [] }), /Select/u);
  for (const filePath of ['', '.', '../alpha.txt', '/alpha.txt', '.git/config', 'nested/../alpha.txt', 'C:/alpha.txt']) {
    assert.throws(() => gitDiscardSelection({ targets: [{ path: filePath, scope: 'working' }] }), /workspace/u);
  }
  assert.throws(() => gitDiscardSelection({ targets: [{ path: 'alpha.txt', scope: 'commit' }] }), /scope/u);
});

test('selects individual rows, toggles multiple rows, and selects a contiguous range', () => {
  const alpha: GitDiscardTarget = { path: 'alpha.txt', scope: 'working' };
  const beta: GitDiscardTarget = { path: 'beta.txt', scope: 'working' };
  const gamma: GitDiscardTarget = { path: 'gamma.txt', scope: 'working' };
  const stagedAlpha: GitDiscardTarget = { path: 'alpha.txt', scope: 'staged' };
  const targets = [alpha, beta, gamma, stagedAlpha];
  const select = (selected: GitDiscardTarget[], target: GitDiscardTarget, toggle = false, range = false) => (
    selectGitChanges({ targets, selected, target, anchor: alpha, toggle, range })
  );
  assert.deepEqual(select([alpha, beta], gamma), [gamma]);
  assert.deepEqual(select([alpha], gamma, true), [alpha, gamma]);
  assert.deepEqual(select([alpha, gamma], alpha, true), [gamma]);
  assert.deepEqual(select([alpha], gamma, false, true), [alpha, beta, gamma]);
  assert.deepEqual(select([stagedAlpha], beta, true, true), [stagedAlpha, alpha, beta]);
  assert.deepEqual(select([alpha], stagedAlpha, true), [alpha, stagedAlpha]);
});
