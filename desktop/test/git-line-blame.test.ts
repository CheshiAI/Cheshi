import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { GitService } from '../lib/git-service.mts';
import { parseLineBlame, readGitLineBlame, readGitLineCommit } from '../lib/git-line-blame.mts';
import { gitLineBlameRequest } from '../shared/git-line-blame.ts';

function fixture(t: TestContext, content = 'alpha\nbeta\n') {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-line-blame-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Cheshi Test');
  git('config', 'user.email', 'test@example.test');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(directory, 'sample.txt'), content);
  git('add', 'sample.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'initial content');
  const first = git('rev-parse', 'HEAD');
  const service = new GitService({ workspaceRoot: directory });
  const read = (line: number, buffer = content, path = 'sample.txt') => readGitLineBlame(service, { path, line, content: buffer });
  return { directory, git, first, read, service };
}

test('reports the last modifying commit, including unchanged lines shifted by unsaved edits', async t => {
  const { directory, git, first, read } = fixture(t);
  writeFileSync(join(directory, 'sample.txt'), 'alpha\nchanged beta\n');
  git('add', 'sample.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'change beta');
  const last = git('rev-parse', 'HEAD');
  const changed = await read(2, 'alpha\nchanged beta\n');
  assert.equal(changed.status, 'committed');
  if (changed.status === 'committed') {
    assert.equal(changed.hash, last);
    assert.equal(changed.summary, 'change beta');
    assert.equal(changed.author, 'Cheshi Test');
    assert.ok(Number.isFinite(Date.parse(changed.authoredAt)));
  }
  const shifted = await read(2, 'unsaved new line\nalpha\nchanged beta\n');
  assert.equal(shifted.status, 'committed');
  if (shifted.status === 'committed') { assert.equal(shifted.hash, first); assert.equal(shifted.originalLine, 1); }
  assert.deepEqual(await read(1, 'unsaved new line\nalpha\nchanged beta\n'), { status: 'uncommitted' });
});

test('line commit follows the historical filename and returns only that file with the full message', async t => {
  const { directory, git, service } = fixture(t);
  writeFileSync(join(directory, 'sample.txt'), 'alpha\nupdated beta\n');
  writeFileSync(join(directory, 'other.txt'), 'related change\n');
  git('add', 'sample.txt', 'other.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'update two files', '-m', 'Detailed reason.\nAnother paragraph.');
  const expectedHash = git('rev-parse', 'HEAD');
  git('mv', 'sample.txt', 'renamed.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'rename file');
  const before = ['renamed.txt', '.git/index', '.git/HEAD'].map(path => readFileSync(join(directory, path)));
  const result = await readGitLineCommit(service, { path: 'renamed.txt', line: 3, content: 'unsaved\nalpha\nupdated beta\n' });
  assert.equal(result.status, 'committed');
  if (result.status === 'committed') {
    assert.equal(result.blame.hash, expectedHash);
    assert.equal(result.blame.originalPath, 'sample.txt');
    assert.equal(result.blame.originalLine, 2);
    assert.equal(result.message, 'update two files\n\nDetailed reason.\nAnother paragraph.');
    assert.match(result.patch, /diff --git a\/sample.txt b\/sample.txt/u);
    assert.doesNotMatch(result.patch, /other.txt|related change/u);
    assert.match(result.patch, /\+updated beta/u);
  }
  assert.deepEqual(['renamed.txt', '.git/index', '.git/HEAD'].map(path => readFileSync(join(directory, path))), before);
});

test('file filtering is literal and repository rooted in a nested workspace', async t => {
  const { directory, git } = fixture(t);
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src', '[a].txt'), 'chosen file\n');
  writeFileSync(join(directory, 'src', 'a.txt'), 'other file\n');
  git('add', 'src');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'add nested files');
  const result = await readGitLineCommit(new GitService({ workspaceRoot: join(directory, 'src') }),
    { path: '[a].txt', line: 1, content: 'chosen file\n' });
  assert.equal(result.status, 'committed');
  if (result.status === 'committed') {
    assert.match(result.patch, /\+chosen file/u);
    assert.doesNotMatch(result.patch, /other file/u);
  }
});

test('initial commits have a diff and uncommitted lines never load commit details', async t => {
  const { first, service } = fixture(t);
  const result = await readGitLineCommit(service, { path: 'sample.txt', line: 1, content: 'alpha\nbeta\n' });
  assert.equal(result.status, 'committed');
  if (result.status === 'committed') {
    assert.equal(result.blame.hash, first);
    assert.match(result.patch, /\+alpha/u);
  }
  const runGit = service.runGit.bind(service);
  const commands: string[][] = [];
  service.runGit = (args, options) => { commands.push(args); return runGit(args, options); };
  assert.deepEqual(await readGitLineCommit(service, { path: 'sample.txt', line: 1, content: 'new\nbeta\n' }), { status: 'uncommitted' });
  assert.equal(commands.some(args => args.includes('show')), false);
});

test('merge conflict resolutions return a unified first-parent patch', async t => {
  const { directory, git, service } = fixture(t);
  git('switch', '-c', 'side');
  writeFileSync(join(directory, 'sample.txt'), 'side\nbeta\n');
  git('add', 'sample.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'side change');
  git('switch', 'main');
  writeFileSync(join(directory, 'sample.txt'), 'main\nbeta\n');
  git('add', 'sample.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'main change');
  assert.throws(() => git('-c', 'commit.gpgsign=false', 'merge', 'side'));
  writeFileSync(join(directory, 'sample.txt'), 'resolved\nbeta\n');
  git('add', 'sample.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'merge resolution');
  const result = await readGitLineCommit(service, { path: 'sample.txt', line: 1, content: 'resolved\nbeta\n' });
  assert.equal(result.status, 'committed');
  if (result.status === 'committed') {
    assert.equal(result.blame.hash, git('rev-parse', 'HEAD'));
    assert.match(result.patch, /-main\n\+resolved/u);
    assert.doesNotMatch(result.patch, /diff --cc/u);
  }
});

test('never writes editor buffers, the index, HEAD, or working changes', async t => {
  const { directory, git, read } = fixture(t);
  writeFileSync(join(directory, 'sample.txt'), 'staged\nbeta\n');
  git('add', 'sample.txt');
  writeFileSync(join(directory, 'sample.txt'), 'unstaged\nbeta\n');
  const snapshot = () => ['sample.txt', '.git/index', '.git/HEAD', '.git/logs/HEAD'].map(path => readFileSync(join(directory, path)));
  const before = snapshot();
  assert.deepEqual(await read(1, 'unsaved\nbeta\n'), { status: 'uncommitted' });
  assert.deepEqual(snapshot(), before);
});

test('handles CRLF, untracked files, literal filenames, and trailing empty editor lines', async t => {
  const { directory, first, read, git } = fixture(t, 'alpha\r\nbeta\r\n');
  const result = await read(2);
  assert.equal(result.status, 'committed');
  if (result.status === 'committed') assert.equal(result.hash, first);
  assert.deepEqual(await read(3), { status: 'uncommitted' });
  writeFileSync(join(directory, 'new.txt'), 'new');
  assert.deepEqual(await read(1, 'new', 'new.txt'), { status: 'uncommitted' });
  git('add', 'new.txt');
  assert.deepEqual(await read(1, 'new', 'new.txt'), { status: 'uncommitted' });
  const special = ':(glob)* spaced.txt';
  writeFileSync(join(directory, special), 'literal\n');
  git('--literal-pathspecs', 'add', '--', special);
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'literal file');
  assert.equal((await read(1, 'literal\n', special)).status, 'committed');
});

test('rejects out-of-workspace paths and symlinks before Git reads them', async t => {
  const { directory, read } = fixture(t);
  for (const path of ['/etc/passwd', '../outside', '.git/config', 'a/../../b', 'a\0b']) {
    await assert.rejects(read(1, 'text', path), /Invalid/u);
  }
  createSymbolicLink(tmpdir(), join(directory, 'outside'));
  // This resolves outside the workspace even though its lexical path is inside it.
  await assert.rejects(read(1, 'text', 'outside'), /within the workspace/u);
  for (const line of [0, -1, 1.5, NaN, 3]) assert.throws(() => gitLineBlameRequest({ path: 'sample.txt', line, content: 'a\nb' }));
});

test('does not invent history for missing files, non-repositories, or malformed Git output', async t => {
  const { read, service, directory } = fixture(t);
  assert.deepEqual(await read(1, 'x', 'missing'), { status: 'unavailable' });
  const nonrepo = join(directory, 'plain');
  // Use a separate temporary directory so no parent repository is discovered.
  const root = mkdtempSync(join(tmpdir(), 'cheshi-no-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file'), nonrepo);
  assert.deepEqual(await readGitLineBlame(new GitService({ workspaceRoot: root }), { path: 'file', line: 1, content: 'x' }), { status: 'unavailable' });
  service.runGit = async () => ({ stdout: '', stderr: '', exitCode: 128, truncated: false });
  assert.deepEqual(await read(1), { status: 'unavailable' });
  assert.throws(() => parseLineBlame('invalid output'));
  assert.throws(() => parseLineBlame(`${'a'.repeat(40)} 1 1 1\nauthor A\nauthor-time invalid\nsummary message\n\tx`));
});
