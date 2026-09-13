import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GitCommandError } from '../lib/git-command.mts';
import { GitService } from '../lib/git-service.mts';
import type { CommandResult } from '../lib/git-types.mts';
import { pullRequestReviewLocation } from '../frontend/src/features/git/gitWorkspaceModel.ts';
import { parseUnifiedDiff } from '../frontend/src/features/git/unifiedDiff.ts';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const hunk = '@@ -1 +1 @@\n-before\n+after';
const rawPatch = `diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n${hunk}\n`;

interface ApiFile {
  filename: string;
  status: string;
  previous_filename?: string | null;
  patch?: string | null;
}

function output(stdout: string, exitCode = 0, truncated = false): CommandResult {
  return { stdout, stderr: '', exitCode, truncated };
}

function oversizedDiff(): GitCommandError {
  return new GitCommandError('HTTP 406: diff exceeded the maximum number of files (300).', {
    stderr: 'PullRequest.diff too_large', exitCode: 1,
  });
}

function fixture(files: ApiFile[], options: {
  rawError?: Error | null;
  rawTruncated?: boolean;
  local?: CommandResult;
  total?: number;
  changedRevision?: boolean;
  pageData?: (page: number) => unknown;
  truncatedPage?: boolean;
} = {}) {
  const githubCalls: string[][] = [];
  const gitCalls: string[][] = [];
  let revisionReads = 0;
  const service = new GitService({ workspaceRoot: process.cwd() });
  service.runGit = async (args: string[]) => {
    gitCalls.push(args);
    return options.local ?? output('', 128);
  };
  service.runGitHub = async (args: string[]) => {
    githubCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'diff') {
      const error = options.rawError === undefined ? oversizedDiff() : options.rawError;
      if (error) throw error;
      return output(rawPatch, 0, options.rawTruncated);
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return output(JSON.stringify({ headRefOid: 'c'.repeat(40) }));
    }
    if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}/pulls/12') {
      revisionReads += 1;
      return output(JSON.stringify({
        base, head: options.changedRevision && revisionReads > 1 ? 'd'.repeat(40) : head,
        files: options.total ?? files.length,
      }));
    }
    if (args[0] === 'api' && args[1]?.includes('/files?')) {
      const page = Number(new URL(args[1], 'https://example.test').searchParams.get('page'));
      const value = options.pageData ? options.pageData(page) : files.slice((page - 1) * 100, page * 100);
      return output(JSON.stringify(value), 0, options.truncatedPage);
    }
    if (args[0] === 'api' && args[1]?.includes(`/commits/${head}?`)) {
      const page = Number(new URL(args[1], 'https://example.test').searchParams.get('page'));
      return output(JSON.stringify({ sha: head, files: files.slice((page - 1) * 100, page * 100) }));
    }
    assert.fail(`Unexpected GitHub command: ${args.join(' ')}`);
  };
  return { service, githubCalls, gitCalls };
}

test('normal pull request diffs keep the existing CLI path and truncation flag', async () => {
  const { service, githubCalls, gitCalls } = fixture([], { rawError: null, rawTruncated: true });
  const result = await service.getPullRequestDiff(12);
  assert.equal(result.patch, rawPatch);
  assert.equal(result.headRefOid, 'c'.repeat(40));
  assert.equal(result.truncated, true);
  assert.equal(githubCalls.length, 2);
  assert.equal(gitCalls.length, 0);
});

for (const message of ['HTTP 403: forbidden', 'HTTP 406: unsupported media type']) {
  test(`does not use the oversized fallback for ${message}`, async () => {
    const error = new GitCommandError(message);
    const { service, githubCalls, gitCalls } = fixture([], { rawError: error });
    await assert.rejects(service.getPullRequestDiff(12), (actual: unknown) => actual === error);
    assert.equal(githubCalls.some((args) => args[0] === 'api'), false);
    assert.equal(gitCalls.length, 0);
  });
}

test('oversized diffs use the exact PR commits locally and keep their head for reviews', async () => {
  const { service, githubCalls, gitCalls } = fixture([], { local: output(rawPatch), total: 653 });
  const result = await service.getPullRequestDiff(12);
  assert.equal(result.patch, rawPatch);
  assert.equal(result.headRefOid, head);
  assert.equal(result.truncated, false);
  assert.ok(gitCalls[0]?.includes(`${base}...${head}`));
  assert.equal(githubCalls.some((args) => args[1]?.includes('/files?')), false);
});

test('paginates all 653 files when PR commits are not available locally', async () => {
  const files = Array.from({ length: 653 }, (_, index) => ({
    filename: `src/file-${index}.ts`, status: 'modified', previous_filename: null, patch: hunk,
  }));
  const { service, githubCalls } = fixture(files);
  const result = await service.getPullRequestDiff(12);
  const parsed = parseUnifiedDiff(result.patch);
  assert.equal(parsed.length, 653);
  assert.equal(parsed[0]?.path, 'src/file-0.ts');
  assert.equal(parsed.at(-1)?.path, 'src/file-652.ts');
  assert.equal(githubCalls.filter((args) => args[1]?.includes('/files?')).length, 7);
  assert.equal(result.headRefOid, head);
  assert.equal(result.truncated, false);
});

test('paged patches preserve renamed paths, added and removed files, and review line numbers', async () => {
  const renamedPath = 'src/new "한글" name.ts';
  const { service } = fixture([
    { filename: renamedPath, previous_filename: 'src/old name.ts', status: 'renamed', patch: hunk },
    { filename: 'added.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+added' },
    { filename: 'removed.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-removed' },
    { filename: 'binary.png', status: 'modified', patch: null },
    { filename: 'large-text.ts', status: 'modified' },
  ]);
  const result = await service.getPullRequestDiff(12);
  const parsed = parseUnifiedDiff(result.patch);
  assert.equal(parsed.length, 5);
  const renamed = parsed[0];
  assert.ok(renamed);
  assert.equal(renamed.path, renamedPath);
  assert.equal(renamed.oldPath, 'src/old name.ts');
  const addedLine = renamed.lines.find((line) => line.kind === 'addition');
  assert.ok(addedLine);
  assert.deepEqual(pullRequestReviewLocation(renamed, addedLine), { path: renamedPath, line: 1, side: 'RIGHT' });
  assert.equal(parsed[1]?.oldPath, null);
  assert.equal(parsed[1]?.additions, 1);
  assert.equal(parsed[2]?.path, 'removed.ts');
  assert.equal(parsed[2]?.deletions, 1);
  for (const file of parsed.slice(3)) {
    assert.ok(file.lines.some((line) => line.content.includes('did not provide a text diff')));
    assert.ok(file.lines.every((line) => pullRequestReviewLocation(file, line) === null));
  }
});

test('rejects missing pages and duplicate files instead of returning an incomplete list', async () => {
  const files = Array.from({ length: 101 }, (_, index) => ({ filename: `${index}.ts`, status: 'modified', patch: hunk }));
  for (const tail of [[], [files[0]]]) {
    const { service } = fixture(files, { pageData: (page: number) => page === 1 ? files.slice(0, 100) : tail });
    await assert.rejects(service.getPullRequestDiff(12), /incomplete|duplicate/u);
  }
});

test('rejects a truncated JSON page and a PR revision that changes during pagination', async () => {
  const files = [{ filename: 'file.ts', status: 'modified', patch: hunk }];
  const truncated = fixture(files, { truncatedPage: true });
  await assert.rejects(truncated.service.getPullRequestDiff(12), /response exceeded the size limit/u);
  const changed = fixture(files, { changedRevision: true });
  await assert.rejects(changed.service.getPullRequestDiff(12), /changed while its diff was loading/u);
});

test('reports the API file limit when the required local commits are unavailable', async () => {
  const { service } = fixture([], { total: 3001 });
  await assert.rejects(service.getPullRequestDiff(12), /3001 files.*Fetch its base and head commits/u);
});

test('a selected commit bypasses all whole pull request requests', async () => {
  const { service, githubCalls, gitCalls } = fixture([], { local: output(rawPatch) });
  const result = await service.getPullRequestDiff(12, head);
  assert.equal(result.patch, rawPatch);
  assert.equal(result.headRefOid, head);
  assert.equal(githubCalls.length, 0);
  assert.ok(gitCalls[0]?.includes('show'));
  assert.ok(gitCalls[0]?.includes(head));
});

test('missing local commits use only the selected commit API and paginate its files', async () => {
  const files = Array.from({ length: 301 }, (_, index) => ({
    filename: `selected/${index}.ts`, status: 'modified', patch: hunk,
  }));
  const { service, githubCalls } = fixture(files);
  const result = await service.getPullRequestDiff(12, head);
  assert.equal(parseUnifiedDiff(result.patch).length, 301);
  assert.equal(result.headRefOid, head);
  assert.equal(result.truncated, false);
  assert.equal(githubCalls.length, 4);
  assert.ok(githubCalls.every((args) => args[0] === 'api' && args[1]?.includes(`/commits/${head}?`)));
});

test('invalid commit selections fail before running Git or GitHub commands', async () => {
  const { service, githubCalls, gitCalls } = fixture([]);
  for (const value of ['HEAD', '--all', `${head}^`, '', null, 12]) {
    await assert.rejects(service.getPullRequestDiff(12, value), /commit/u);
  }
  assert.equal(githubCalls.length, 0);
  assert.equal(gitCalls.length, 0);
});

test('the selected commit diff excludes earlier and later changes and handles roots and merges', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-pr-commit-diff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'Cheshi Test');
  git('config', 'user.email', 'cheshi@example.test');
  git('config', 'commit.gpgsign', 'false');
  const commitFile = (filename: string): string => {
    writeFileSync(path.join(directory, filename), `${filename}\n`);
    git('add', filename);
    git('commit', '--quiet', '-m', filename);
    return git('rev-parse', 'HEAD');
  };
  const root = commitFile('root.txt');
  const selected = commitFile('selected.txt');
  commitFile('later.txt');
  git('switch', '--quiet', '-c', 'side', root);
  commitFile('side.txt');
  git('switch', '--quiet', 'main');
  git('merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');
  const merge = git('rev-parse', 'HEAD');
  writeFileSync(path.join(directory, 'selected.txt'), 'uncommitted local work\n');
  const status = git('status', '--porcelain');
  const service = new GitService({ workspaceRoot: directory });
  service.runGitHub = async () => assert.fail('Local commit reads must not call GitHub.');
  for (const [oid, filename] of [[root, 'root.txt'], [selected, 'selected.txt'], [merge, 'side.txt']]) {
    const result = await service.getPullRequestDiff(12, oid);
    assert.deepEqual(parseUnifiedDiff(result.patch).map((file) => file.path), [filename]);
    assert.doesNotMatch(result.patch, /uncommitted local work/u);
  }
  assert.equal(git('rev-parse', 'HEAD'), merge);
  assert.equal(git('status', '--porcelain'), status);
});

test('local fallback compares committed PR content without changing the working tree', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-large-pr-diff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'Cheshi Test');
  git('config', 'user.email', 'cheshi@example.test');
  git('config', 'commit.gpgsign', 'false');
  const filename = path.join(directory, 'file.txt');
  writeFileSync(filename, 'base content\n');
  git('add', 'file.txt');
  git('commit', '--quiet', '-m', 'base');
  const baseOid = git('rev-parse', 'HEAD');
  writeFileSync(filename, 'committed PR content\n');
  git('commit', '--quiet', '-am', 'head');
  const headOid = git('rev-parse', 'HEAD');
  writeFileSync(filename, 'uncommitted local work\n');
  const status = git('status', '--porcelain');
  const service = new GitService({ workspaceRoot: directory });
  service.runGitHub = async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'diff') throw oversizedDiff();
    if (args[0] === 'pr') return output(JSON.stringify({ headRefOid: headOid }));
    return output(JSON.stringify({ base: baseOid, head: headOid, files: 1 }));
  };
  const result = await service.getPullRequestDiff(12);
  assert.match(result.patch, /\+committed PR content/u);
  assert.doesNotMatch(result.patch, /uncommitted local work/u);
  assert.equal(result.headRefOid, headOid);
  assert.equal(git('rev-parse', 'HEAD'), headOid);
  assert.equal(git('status', '--porcelain'), status);
  assert.equal(readFileSync(filename, 'utf8'), 'uncommitted local work\n');
});
