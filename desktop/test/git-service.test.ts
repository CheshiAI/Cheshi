import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { GitService } from '../lib/git-service.mts';
import { loadForgeConfiguration } from './forge-test-helpers.ts';

type GitSnapshot = Awaited<ReturnType<GitService['getSnapshot']>>;
type AvailableGitSnapshot = Extract<GitSnapshot, { available: true }>;

function availableSnapshot(snapshot: GitSnapshot): AvailableGitSnapshot {
  if (!snapshot.available) throw new Error(`Expected an available Git repository: ${snapshot.message}`);
  return snapshot;
}

function runGit(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
}

function createRepository() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-service-'));
  runGit(directory, 'init', '-b', 'main');
  runGit(directory, 'config', 'user.name', 'Cheshi Test');
  runGit(directory, 'config', 'user.email', 'cheshi@example.test');
  writeFileSync(path.join(directory, 'alpha.txt'), 'first\n');
  runGit(directory, 'add', 'alpha.txt');
  runGit(directory, 'commit', '-m', 'initial commit');
  return directory;
}

function createPullRequestCleanupFixture({ squash = false } = {}) {
  const directory = createRepository();
  const remoteDirectory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-cleanup-remote-'));
  const collaboratorDirectory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-cleanup-collaborator-'));
  const branch = 'feature/cleanup';
  const baseBranch = 'main';
  const pullRequestNumber = 11;

  runGit(remoteDirectory, 'init', '--bare');
  runGit(remoteDirectory, 'symbolic-ref', 'HEAD', `refs/heads/${baseBranch}`);
  runGit(directory, 'remote', 'add', 'origin', remoteDirectory);
  runGit(directory, 'push', '--set-upstream', 'origin', baseBranch);
  runGit(directory, 'remote', 'set-head', 'origin', baseBranch);
  runGit(directory, 'switch', '-c', branch);
  writeFileSync(path.join(directory, 'cleanup.txt'), 'merged branch content\n');
  runGit(directory, 'add', 'cleanup.txt');
  runGit(directory, 'commit', '-m', 'add cleanup branch');
  runGit(directory, 'push', '--set-upstream', 'origin', branch);
  const headRefOid = runGit(directory, 'rev-parse', branch).trim();

  runGit(collaboratorDirectory, 'clone', remoteDirectory, '.');
  runGit(collaboratorDirectory, 'config', 'user.name', 'Cheshi Collaborator');
  runGit(collaboratorDirectory, 'config', 'user.email', 'collaborator@example.test');
  if (squash) {
    runGit(collaboratorDirectory, 'merge', '--squash', `origin/${branch}`);
    runGit(collaboratorDirectory, 'commit', '-m', 'squash pull request');
  } else {
    runGit(collaboratorDirectory, 'merge', '--no-ff', `origin/${branch}`, '-m', 'merge pull request');
  }
  runGit(collaboratorDirectory, 'push', 'origin', baseBranch);
  runGit(remoteDirectory, 'update-ref', '-d', `refs/heads/${branch}`);

  const fakeGitHubCli = path.join(collaboratorDirectory, 'fake-cleanup-gh');
  writeFileSync(fakeGitHubCli, `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "${pullRequestNumber}" ] && [ "$4" = "--json" ]; then
  printf '%s\\n' '{"state":"MERGED","headRefOid":"${headRefOid}","headRefName":"${branch}","baseRefName":"${baseBranch}","isCrossRepository":false}'
  exit 0
fi
exit 2
`);
  chmodSync(fakeGitHubCli, 0o755);

  return {
    baseBranch,
    branch,
    collaboratorDirectory,
    directory,
    fakeGitHubCli,
    pullRequestNumber,
    remoteDirectory,
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

for (const remoteName of ['origin', 'team']) {
  test(`compares an unpublished branch with the ${remoteName} default branch before and after committing`, async () => {
    const directory = createRepository();
    const remoteDirectory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-pr-base-'));
    try {
      runGit(remoteDirectory, 'init', '--bare');
      runGit(directory, 'remote', 'add', remoteName, remoteDirectory);
      runGit(directory, 'push', '--set-upstream', remoteName, 'main');
      runGit(directory, 'remote', 'set-head', remoteName, 'main');
      runGit(directory, 'switch', '-c', 'feature/unpublished');
      const service = new GitService({ workspaceRoot: directory });

      const initial = availableSnapshot(await service.getSnapshot());
      assert.equal(initial.upstream, null);
      assert.equal(initial.pullRequestBase, `${remoteName}/main`);
      assert.equal(initial.pullRequestAhead, 0);

      writeFileSync(path.join(directory, 'alpha.txt'), 'first\nproposed change\n');
      runGit(directory, 'add', 'alpha.txt');
      const staged = availableSnapshot(await service.getSnapshot());
      assert.equal(staged.pullRequestAhead, 0);
      assert.equal(staged.changes[0]?.staged, true);

      runGit(directory, 'commit', '-m', 'add proposed change');
      const committed = availableSnapshot(await service.getSnapshot());
      assert.equal(committed.upstream, null);
      assert.equal(committed.upstreamPublished, false);
      assert.equal(committed.pullRequestAhead, 1);

      runGit(directory, 'remote', 'add', 'secondary', remoteDirectory);
      if (remoteName === 'team') {
        const ambiguous = availableSnapshot(await service.getSnapshot());
        assert.equal(ambiguous.pullRequestBase, null);
        assert.equal(ambiguous.pullRequestAhead, null);
        runGit(directory, 'config', 'remote.pushDefault', remoteName);
      }
      const selected = availableSnapshot(await service.getSnapshot());
      assert.equal(selected.pullRequestBase, `${remoteName}/main`);
      assert.equal(selected.pullRequestAhead, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(remoteDirectory, { recursive: true, force: true });
    }
  });
}

test('keeps the PR comparison unknown when a default remote branch is unavailable', async () => {
  const directory = createRepository();
  try {
    const service = new GitService({ workspaceRoot: directory });
    const local = availableSnapshot(await service.getSnapshot());
    assert.equal(local.pullRequestBase, null);
    assert.equal(local.pullRequestAhead, null);
    runGit(directory, 'remote', 'add', 'origin', directory);
    const missingDefault = availableSnapshot(await service.getSnapshot());
    assert.equal(missingDefault.pullRequestBase, null);
    assert.equal(missingDefault.pullRequestAhead, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reads status, diffs, branches, and commits from a real repository', async () => {
  const directory = createRepository();
  try {
    writeFileSync(path.join(directory, 'alpha.txt'), 'first\nsecond\n');
    writeFileSync(path.join(directory, 'new.txt'), 'untracked\n');
    const service = new GitService({ workspaceRoot: directory });

    const snapshot = availableSnapshot(await service.getSnapshot());
    assert.equal(snapshot.head, 'main');
    assert.equal(snapshot.changes.length, 2);
    assert.equal(snapshot.commits[0]?.subject, 'initial commit');
    assert.equal(snapshot.branches.find((branch) => branch.name === 'main')?.current, true);

    const workingDiff = await service.getDiff({ scope: 'working', path: 'alpha.txt' });
    assert.match(workingDiff.patch, /\+second/);
    const untrackedDiff = await service.getDiff({ scope: 'working', path: 'new.txt' });
    assert.match(untrackedDiff.patch, /\+untracked/);

    const stagedSnapshot = availableSnapshot(await service.stagePaths(['alpha.txt', 'new.txt']));
    assert.equal(stagedSnapshot.changes.find((change) => change.path === 'alpha.txt')?.staged, true);
    const stagedDiff = await service.getDiff({ scope: 'staged', path: 'alpha.txt' });
    assert.match(stagedDiff.patch, /\+second/);

    const committed = await service.commit('update alpha');
    const committedSnapshot = availableSnapshot(committed.snapshot);
    assert.equal(committedSnapshot.commits[0]?.subject, 'update alpha');

    const created = availableSnapshot(await service.createBranch('feature/git-view'));
    assert.equal(created.head, 'feature/git-view');
    const checkedOut = availableSnapshot(await service.checkoutBranch('main'));
    assert.equal(checkedOut.head, 'main');

    await assert.rejects(
      service.getDiff({ scope: 'working', path: '../outside.txt' }),
      /inside the workspace/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reports external repository metadata changes without polling', async () => {
  const directory = createRepository();
  const service = new GitService({ workspaceRoot: directory });
  const changes: number[] = [];
  const stopWatching = await service.watchRepository(() => changes.push(Date.now()));

  try {
    await service.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(changes, []);

    writeFileSync(path.join(directory, 'external.txt'), 'external\n');
    runGit(directory, 'add', 'external.txt');
    runGit(directory, 'commit', '-m', 'external commit');
    await waitFor(() => changes.length > 0, 'Expected the external commit to emit a repository change.');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(changes.length, 1);
  } finally {
    stopWatching();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('creates a branch from the selected local branch', async () => {
  const directory = createRepository();
  try {
    runGit(directory, 'branch', 'stable');
    writeFileSync(path.join(directory, 'alpha.txt'), 'first\nmain only\n');
    runGit(directory, 'add', 'alpha.txt');
    runGit(directory, 'commit', '-m', 'advance main');
    const mainHead = runGit(directory, 'rev-parse', 'main').trim();
    const stableHead = runGit(directory, 'rev-parse', 'stable').trim();
    const service = new GitService({ workspaceRoot: directory });

    const snapshot = availableSnapshot(
      await service.createBranch('feature/from-stable', 'refs/heads/stable'),
    );

    assert.equal(snapshot.head, 'feature/from-stable');
    assert.equal(runGit(directory, 'rev-parse', 'HEAD').trim(), stableHead);
    assert.notEqual(runGit(directory, 'rev-parse', 'HEAD').trim(), mainHead);
    await assert.rejects(
      service.createBranch('feature/invalid-base', 'HEAD'),
      /local or remote branch/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fetches a remote branch and fast-forwards its local branch', async () => {
  const directory = createRepository();
  const remoteDirectory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-service-remote-'));
  const updaterDirectory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-service-updater-'));
  try {
    runGit(remoteDirectory, 'init', '--bare');
    runGit(directory, 'remote', 'add', 'origin', remoteDirectory);
    runGit(directory, 'push', '-u', 'origin', 'main');
    runGit(remoteDirectory, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    runGit(directory, 'remote', 'set-head', 'origin', 'main');
    runGit(updaterDirectory, 'clone', remoteDirectory, '.');
    runGit(updaterDirectory, 'config', 'user.name', 'Cheshi Updater');
    runGit(updaterDirectory, 'config', 'user.email', 'updater@example.test');
    writeFileSync(path.join(updaterDirectory, 'alpha.txt'), 'first\nremote update\n');
    runGit(updaterDirectory, 'add', 'alpha.txt');
    runGit(updaterDirectory, 'commit', '-m', 'remote update');
    runGit(updaterDirectory, 'push', 'origin', 'main');

    const service = new GitService({ workspaceRoot: directory });
    const initialSnapshot = availableSnapshot(await service.getSnapshot());
    assert.deepEqual(
      initialSnapshot.branches.filter((branch) => branch.remote).map((branch) => branch.fullName),
      ['refs/remotes/origin/main'],
    );
    const fetched = await service.updateBranch('refs/remotes/origin/main');
    const fetchedSnapshot = availableSnapshot(fetched.snapshot);
    assert.equal(fetchedSnapshot.behind, 1);
    assert.deepEqual(
      fetchedSnapshot.branches.find((branch) => branch.fullName === 'refs/heads/main'),
      {
        name: 'main',
        fullName: 'refs/heads/main',
        hash: initialSnapshot.branches.find((branch) => branch.fullName === 'refs/heads/main')?.hash,
        upstream: 'origin/main',
        upstreamRemote: 'origin',
        ahead: 0,
        behind: 1,
        current: true,
        remote: false,
      },
    );
    assert.equal(runGit(directory, 'show', 'refs/remotes/origin/main:alpha.txt'), 'first\nremote update\n');

    const updated = await service.updateBranch('refs/heads/main');
    const updatedSnapshot = availableSnapshot(updated.snapshot);
    assert.equal(updatedSnapshot.behind, 0);
    assert.equal(updatedSnapshot.head, 'main');
    const updatedMain = updatedSnapshot.branches.find((branch) => branch.fullName === 'refs/heads/main');
    assert.equal(updatedMain?.ahead, 0);
    assert.equal(updatedMain?.behind, 0);
    assert.equal(runGit(directory, 'show', 'main:alpha.txt'), 'first\nremote update\n');
  } finally {
    rmSync(updaterDirectory, { recursive: true, force: true });
    rmSync(remoteDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pushes the current branch and configures its upstream', async () => {
  const directory = createRepository();
  const remoteDirectory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-service-push-remote-'));
  try {
    runGit(remoteDirectory, 'init', '--bare');
    runGit(directory, 'remote', 'add', 'origin', remoteDirectory);
    runGit(directory, 'push', '--set-upstream', 'origin', 'main');
    const service = new GitService({ workspaceRoot: directory });
    await service.createBranch('feature/push-current');
    writeFileSync(path.join(directory, 'feature.txt'), 'first feature commit\n');
    runGit(directory, 'add', 'feature.txt');
    runGit(directory, 'commit', '-m', 'add feature');

    const firstPush = await service.pushCurrentBranch();
    const firstPushSnapshot = availableSnapshot(firstPush.snapshot);
    assert.equal(firstPushSnapshot.head, 'feature/push-current');
    assert.equal(firstPushSnapshot.upstream, 'origin/feature/push-current');
    assert.equal(firstPushSnapshot.ahead, 0);
    assert.equal(
      runGit(directory, 'rev-parse', 'HEAD').trim(),
      runGit(remoteDirectory, 'rev-parse', 'refs/heads/feature/push-current').trim(),
    );

    writeFileSync(path.join(directory, 'feature.txt'), 'first feature commit\nsecond feature commit\n');
    runGit(directory, 'add', 'feature.txt');
    runGit(directory, 'commit', '-m', 'update feature');
    assert.equal(availableSnapshot(await service.getSnapshot()).ahead, 1);
    const secondPush = await service.pushCurrentBranch();
    assert.equal(availableSnapshot(secondPush.snapshot).ahead, 0);
    assert.equal(
      runGit(directory, 'rev-parse', 'HEAD').trim(),
      runGit(remoteDirectory, 'rev-parse', 'refs/heads/feature/push-current').trim(),
    );
  } finally {
    rmSync(remoteDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('returns a clear unavailable state outside a repository', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-service-empty-'));
  try {
    const snapshot = await new GitService({ workspaceRoot: directory }).getSnapshot();
    assert.equal(snapshot.available, false);
    assert.match(snapshot.message, /not a git repository/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unstages files before the repository has its first commit', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-service-unborn-'));
  try {
    runGit(directory, 'init', '-b', 'main');
    writeFileSync(path.join(directory, 'first.txt'), 'first\n');
    const service = new GitService({ workspaceRoot: directory });
    const staged = availableSnapshot(await service.stagePaths(['first.txt']));
    assert.equal(staged.changes[0]?.staged, true);
    const unstaged = availableSnapshot(await service.unstagePaths(['first.txt']));
    assert.equal(unstaged.changes[0]?.untracked, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('uses GitHub CLI for pull request listing, creation, checkout, merging, and branch deletion', async () => {
  const directory = createRepository();
  const remoteDirectory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-git-service-pr-remote-'));
  const fakeGitHubCli = path.join(remoteDirectory, 'fake-gh');
  writeFileSync(fakeGitHubCli, `#!/bin/sh
review_state="${remoteDirectory}/fake-review-state"
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":7,"title":"Add Git view","url":"https://github.com/example/cheshi/pull/7","headRefName":"feature/git-view","baseRefName":"main","author":{"login":"dee"},"updatedAt":"2026-08-24T00:00:00Z","isDraft":false,"reviewDecision":"APPROVED","changedFiles":2}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ] && [ "$3" = "--fill" ]; then
  printf '%s\\n' 'https://github.com/example/cheshi/pull/7'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "--json" ]; then
  printf '%s\\n' '{"number":7,"title":"Add Git view","url":"https://github.com/example/cheshi/pull/7","headRefName":"feature/git-view","baseRefName":"main","author":{"login":"dee"},"updatedAt":"2026-08-24T00:00:00Z","isDraft":false,"reviewDecision":"APPROVED","changedFiles":2}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "7" ] && [ "$4" = "--json" ] && [ "$5" = "id,comments,commits,headRefOid" ]; then
  printf '%s\\n' '{"id":"PR_7","headRefOid":"0123456789abcdef0123456789abcdef01234567","comments":[{"id":"IC_1","author":{"login":"dee"},"body":"Looks ready.","createdAt":"2026-08-24T01:00:00Z","url":"https://github.com/example/cheshi/pull/7#issuecomment-1","viewerDidAuthor":true}],"commits":[{"oid":"0123456789abcdef0123456789abcdef01234567","messageHeadline":"Add Git view","messageBody":"Detailed commit body.","authoredDate":"2026-08-24T00:30:00Z","authors":[{"login":"dee","name":"Dee","email":"dee@example.test"}]}]}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "diff" ] && [ "$3" = "7" ] && [ "$4" = "--color" ] && [ "$5" = "never" ]; then
  printf '%s\\n' 'diff --git a/alpha.txt b/alpha.txt' 'index 9c59e24..4f9f2ca 100644' '--- a/alpha.txt' '+++ b/alpha.txt' '@@ -1 +1,2 @@' ' first' '+second' 'diff --git a/new.txt b/new.txt' 'new file mode 100644' 'index 0000000..3e75765' '--- /dev/null' '+++ b/new.txt' '@@ -0,0 +1 @@' '+new file'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ] && [ "$3" = "7" ] && [ "$4" = "--body" ] && [ "$5" = "Ship it from Cheshi." ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "7" ] && [ "$4" = "--json" ] && [ "$5" = "headRefOid" ]; then
  printf '%s\\n' '{"headRefOid":"0123456789abcdef0123456789abcdef01234567"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/{owner}/{repo}/pulls/7/comments" ]; then
  printf '%s\\n' 'single' > "$review_state"
  printf '%s\\n' '{"id":501}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  case "$*" in
    *StartPullRequestReview*)
      printf '%s\\n' 'pending' > "$review_state"
      printf '%s\\n' '{"data":{"addPullRequestReview":{"pullRequestReview":{"id":"PRR_7","state":"PENDING"}}}}'
      ;;
    *AddPullRequestReviewThread*)
      printf '%s\\n' 'pending-added' > "$review_state"
      printf '%s\\n' '{"data":{"addPullRequestReviewThread":{"thread":{"id":"PRRT_2"}}}}'
      ;;
    *SubmitPullRequestReview*)
      printf '%s\\n' 'submitted' > "$review_state"
      printf '%s\\n' '{"data":{"submitPullRequestReview":{"pullRequestReview":{"id":"PRR_7","state":"COMMENTED"}}}}'
      ;;
    *PullRequestReviewThreads*)
      state=""
      if [ -f "$review_state" ]; then state="$(sed -n '1p' "$review_state")"; fi
      if [ "$state" = "single" ]; then
        printf '%s\\n' '{"data":{"node":{"id":"PR_7","reviewThreads":{"nodes":[{"id":"PRRT_1","isResolved":false,"isOutdated":false,"path":"alpha.txt","line":2,"startLine":null,"diffSide":"RIGHT","startDiffSide":null,"subjectType":"LINE","comments":{"nodes":[{"id":"PRRC_1","author":{"login":"dee"},"body":"Explain this line.","createdAt":"2026-08-24T02:00:00Z","url":"https://github.com/example/cheshi/pull/7#discussion_r1","viewerDidAuthor":true,"state":"SUBMITTED"}]}}]},"reviews":{"nodes":[]}},"viewer":{"login":"dee"}}}'
      elif [ "$state" = "pending" ]; then
        printf '%s\\n' '{"data":{"node":{"id":"PR_7","reviewThreads":{"nodes":[{"id":"PRRT_1","isResolved":false,"isOutdated":false,"path":"alpha.txt","line":2,"startLine":null,"diffSide":"RIGHT","startDiffSide":null,"subjectType":"LINE","comments":{"nodes":[{"id":"PRRC_1","author":{"login":"dee"},"body":"Review this line.","createdAt":"2026-08-24T02:00:00Z","url":"https://github.com/example/cheshi/pull/7#discussion_r1","viewerDidAuthor":true,"state":"PENDING"}]}}]},"reviews":{"nodes":[{"id":"PRR_7","state":"PENDING","author":{"login":"dee"},"comments":{"totalCount":1}}]}},"viewer":{"login":"dee"}}}'
      elif [ "$state" = "pending-added" ]; then
        printf '%s\\n' '{"data":{"node":{"id":"PR_7","reviewThreads":{"nodes":[{"id":"PRRT_1","isResolved":false,"isOutdated":false,"path":"alpha.txt","line":2,"startLine":null,"diffSide":"RIGHT","startDiffSide":null,"subjectType":"LINE","comments":{"nodes":[{"id":"PRRC_1","author":{"login":"dee"},"body":"Review this line.","createdAt":"2026-08-24T02:00:00Z","url":"https://github.com/example/cheshi/pull/7#discussion_r1","viewerDidAuthor":true,"state":"PENDING"}]}},{"id":"PRRT_2","isResolved":false,"isOutdated":false,"path":"alpha.txt","line":1,"startLine":null,"diffSide":"RIGHT","startDiffSide":null,"subjectType":"LINE","comments":{"nodes":[{"id":"PRRC_2","author":{"login":"dee"},"body":"Review context too.","createdAt":"2026-08-24T02:01:00Z","url":"https://github.com/example/cheshi/pull/7#discussion_r2","viewerDidAuthor":true,"state":"PENDING"}]}}]},"reviews":{"nodes":[{"id":"PRR_7","state":"PENDING","author":{"login":"dee"},"comments":{"totalCount":2}}]}},"viewer":{"login":"dee"}}}'
      elif [ "$state" = "submitted" ]; then
        printf '%s\\n' '{"data":{"node":{"id":"PR_7","reviewThreads":{"nodes":[{"id":"PRRT_1","isResolved":false,"isOutdated":false,"path":"alpha.txt","line":2,"startLine":null,"diffSide":"RIGHT","startDiffSide":null,"subjectType":"LINE","comments":{"nodes":[{"id":"PRRC_1","author":{"login":"dee"},"body":"Review this line.","createdAt":"2026-08-24T02:00:00Z","url":"https://github.com/example/cheshi/pull/7#discussion_r1","viewerDidAuthor":true,"state":"SUBMITTED"}]}}]},"reviews":{"nodes":[]}},"viewer":{"login":"dee"}}}'
      else
        printf '%s\\n' '{"data":{"node":{"id":"PR_7","reviewThreads":{"nodes":[]},"reviews":{"nodes":[]}},"viewer":{"login":"dee"}}}'
      fi
      ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/{owner}/{repo}/git/refs/heads/feature/git-view" ] && [ "$3" = "--method" ] && [ "$4" = "DELETE" ] && [ "$5" = "--silent" ]; then
  git --git-dir="${remoteDirectory}" update-ref -d refs/heads/feature/git-view
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "7" ] && [ "$4" = "--json" ]; then
  printf '{"state":"MERGED","headRefOid":"%s","headRefName":"feature/git-view","baseRefName":"main","isCrossRepository":false,"isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}\\n' "$(git rev-parse refs/heads/feature/git-view)"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "8" ] && [ "$4" = "--json" ]; then
  printf '%s\\n' '{"state":"OPEN","headRefOid":"0123456789abcdef0123456789abcdef01234567","headRefName":"feature/blocked","baseRefName":"main","isCrossRepository":false,"isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "9" ] && [ "$4" = "--json" ]; then
  printf '%s\\n' '{"state":"MERGED","headRefOid":"0123456789abcdef0123456789abcdef01234567","headRefName":"feature/forked","baseRefName":"main","isCrossRepository":true,"isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "10" ] && [ "$4" = "--json" ]; then
  printf '%s\\n' '{"state":"MERGED","headRefOid":"0123456789abcdef0123456789abcdef01234567","headRefName":"main","baseRefName":"main","isCrossRepository":false,"isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "checkout" ] && [ "$3" = "7" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ] && [ "$3" = "7" ] && [ "$4" = "--squash" ] && [ "$5" = "--match-head-commit" ] && [ "$6" = "$(git rev-parse refs/heads/feature/git-view)" ]; then
  printf '%s\\n' 'merged pull request 7'
  exit 0
fi
exit 2
`);
  chmodSync(fakeGitHubCli, 0o755);

  try {
    runGit(remoteDirectory, 'init', '--bare');
    runGit(directory, 'remote', 'add', 'origin', remoteDirectory);
    runGit(directory, 'push', '--set-upstream', 'origin', 'main');
    runGit(directory, 'remote', 'set-head', 'origin', 'main');
    const service = new GitService({ workspaceRoot: directory, ghExecutable: fakeGitHubCli });
    await service.createBranch('feature/git-view');
    await assert.rejects(service.createPullRequest(), /No commits to propose from feature\/git-view to origin\/main/u);
    await service.pushCurrentBranch();
    const emptyBranchSnapshot = availableSnapshot(await service.getSnapshot());
    assert.equal(emptyBranchSnapshot.upstreamPublished, true);
    assert.equal(emptyBranchSnapshot.pullRequestBase, 'origin/main');
    assert.equal(emptyBranchSnapshot.pullRequestAhead, 0);
    await assert.rejects(
      service.createPullRequest(),
      /No commits to propose from feature\/git-view to origin\/main/u,
    );
    writeFileSync(path.join(directory, 'after-push.txt'), 'local commit after push\n');
    runGit(directory, 'add', 'after-push.txt');
    runGit(directory, 'commit', '-m', 'commit after push');
    await assert.rejects(service.createPullRequest(), /Push feature\/git-view before creating/u);
    await service.pushCurrentBranch();
    const listed = await service.listPullRequests();
    assert.equal(listed.available, true);
    assert.deepEqual(listed.pullRequests[0], {
      number: 7,
      title: 'Add Git view',
      url: 'https://github.com/example/cheshi/pull/7',
      headRefName: 'feature/git-view',
      baseRefName: 'main',
      author: 'dee',
      updatedAt: '2026-08-24T00:00:00Z',
      draft: false,
      reviewDecision: 'APPROVED',
      changedFiles: 2,
    });
    assert.deepEqual(await service.createPullRequest(), listed.pullRequests[0]);
    const pullRequestDetails = {
      number: 7,
      id: 'PR_7',
      headRefOid: '0123456789abcdef0123456789abcdef01234567',
      viewerLogin: 'dee',
      comments: [{
        id: 'IC_1',
        author: 'dee',
        body: 'Looks ready.',
        createdAt: '2026-08-24T01:00:00Z',
        url: 'https://github.com/example/cheshi/pull/7#issuecomment-1',
        viewerDidAuthor: true,
      }],
      commits: [{
        oid: '0123456789abcdef0123456789abcdef01234567',
        headline: 'Add Git view',
        body: 'Detailed commit body.',
        authoredAt: '2026-08-24T00:30:00Z',
        authors: ['dee'],
      }],
      reviewThreads: [],
      pendingReview: null,
    };
    assert.deepEqual(await service.getPullRequestDetails(7), pullRequestDetails);
    const pullRequestDiff = await service.getPullRequestDiff(7);
    assert.equal(pullRequestDiff.number, 7);
    assert.equal(pullRequestDiff.path, null);
    assert.equal(pullRequestDiff.headRefOid, '0123456789abcdef0123456789abcdef01234567');
    assert.equal(pullRequestDiff.truncated, false);
    assert.equal(pullRequestDiff.binary, false);
    assert.match(pullRequestDiff.patch, /diff --git a\/alpha\.txt b\/alpha\.txt/u);
    assert.match(pullRequestDiff.patch, /\+new file/u);
    assert.deepEqual(
      await service.addPullRequestComment({ number: 7, body: ' Ship it from Cheshi. ' }),
      pullRequestDetails,
    );
    const inlineCommentDetails = await service.addPullRequestReviewComment({
      number: 7,
      pullRequestId: 'PR_7',
      commitId: '0123456789abcdef0123456789abcdef01234567',
      path: 'alpha.txt',
      line: 2,
      side: 'RIGHT',
      body: ' Explain this line. ',
      mode: 'comment',
      pendingReviewId: null,
    });
    assert.equal(inlineCommentDetails.reviewThreads[0]?.comments[0]?.body, 'Explain this line.');
    assert.equal(inlineCommentDetails.reviewThreads[0]?.comments[0]?.pending, false);
    const pendingReviewDetails = await service.addPullRequestReviewComment({
      number: 7,
      pullRequestId: 'PR_7',
      commitId: '0123456789abcdef0123456789abcdef01234567',
      path: 'alpha.txt',
      line: 2,
      side: 'RIGHT',
      body: ' Review this line. ',
      mode: 'review',
      pendingReviewId: null,
    });
    assert.deepEqual(pendingReviewDetails.pendingReview, { id: 'PRR_7', commentCount: 1 });
    assert.equal(pendingReviewDetails.reviewThreads[0]?.comments[0]?.pending, true);
    const expandedReviewDetails = await service.addPullRequestReviewComment({
      number: 7,
      pullRequestId: 'PR_7',
      commitId: '0123456789abcdef0123456789abcdef01234567',
      path: 'alpha.txt',
      line: 1,
      side: 'RIGHT',
      body: ' Review context too. ',
      mode: 'review',
      pendingReviewId: 'PRR_7',
    });
    assert.deepEqual(expandedReviewDetails.pendingReview, { id: 'PRR_7', commentCount: 2 });
    assert.equal(expandedReviewDetails.reviewThreads.length, 2);
    const submittedReviewDetails = await service.submitPullRequestReview({
      number: 7,
      reviewId: 'PRR_7',
      event: 'COMMENT',
    });
    assert.equal(submittedReviewDetails.pendingReview, null);
    assert.equal(submittedReviewDetails.reviewThreads[0]?.comments[0]?.pending, false);
    await assert.rejects(
      service.getPullRequestDetails(0),
      /positive integer/u,
    );
    await assert.rejects(
      service.getPullRequestDiff(0),
      /positive integer/u,
    );
    await assert.rejects(
      service.addPullRequestComment({ number: 7, body: '   ' }),
      /between 1 and/u,
    );
    await assert.rejects(
      service.addPullRequestReviewComment({
        number: 7,
        pullRequestId: 'PR_7',
        commitId: 'invalid',
        path: 'alpha.txt',
        line: 2,
        side: 'RIGHT',
        body: 'Invalid commit.',
        mode: 'comment',
        pendingReviewId: null,
      }),
      /full object ID/u,
    );
    await assert.rejects(
      service.submitPullRequestReview({ number: 7, reviewId: 'PRR_7', event: 'INVALID' }),
      /review event is invalid/u,
    );
    const snapshot = await service.checkoutPullRequest(7);
    assert.equal(snapshot.available, true);
    await assert.rejects(
      service.mergePullRequest({ number: 0, method: 'merge' }),
      /positive integer/u,
    );
    await assert.rejects(
      service.mergePullRequest({ number: 7, method: 'invalid' }),
      /merge method is invalid/u,
    );
    await assert.rejects(
      service.mergePullRequest({ number: 8, method: 'merge' }),
      /reviews or checks are blocking/u,
    );
    assert.deepEqual(
      await service.mergePullRequest({ number: 7, method: 'squash' }),
      {
        number: 7,
        method: 'squash',
        headRefName: 'feature/git-view',
        branchDeletionAvailable: true,
        output: 'merged pull request 7',
      },
    );
    await assert.rejects(
      service.deletePullRequestBranch(0),
      /positive integer/u,
    );
    await assert.rejects(
      service.deletePullRequestBranch(8),
      /Only a merged pull request branch/u,
    );
    await assert.rejects(
      service.deletePullRequestBranch(9),
      /another repository/u,
    );
    await assert.rejects(
      service.deletePullRequestBranch(10),
      /base branch cannot be deleted/u,
    );
    const deletedBranch = await service.deletePullRequestBranch(7);
    assert.equal(deletedBranch.number, 7);
    assert.equal(deletedBranch.branch, 'feature/git-view');
    assert.equal(deletedBranch.refreshWarning, null);
    const deletedBranchSnapshot = availableSnapshot(deletedBranch.snapshot);
    assert.equal(
      deletedBranchSnapshot.branches.some((branch) => branch.name === 'origin/feature/git-view'),
      false,
    );
    runGit(directory, 'show-ref', '--verify', '--quiet', 'refs/heads/feature/git-view');
    assert.throws(() => {
      runGit(remoteDirectory, 'show-ref', '--verify', '--quiet', 'refs/heads/feature/git-view');
    });
  } finally {
    rmSync(remoteDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reports incoming base changes and safely cleans up a merged local branch', async () => {
  const fixture = createPullRequestCleanupFixture();
  const {
    baseBranch,
    branch,
    collaboratorDirectory,
    directory,
    fakeGitHubCli,
    pullRequestNumber,
    remoteDirectory,
  } = fixture;
  try {
    const service = new GitService({ workspaceRoot: directory, ghExecutable: fakeGitHubCli });
    writeFileSync(path.join(directory, 'alpha.txt'), 'uncommitted collaboration check\n');
    const dirtyStatus = await service.getPullRequestBranchCleanupStatus(pullRequestNumber);
    assert.equal(dirtyStatus.state, 'worktree-dirty');
    assert.equal(dirtyStatus.canCleanup, false);
    assert.equal(dirtyStatus.baseBehind, 2);
    const mergedBranchSnapshot = availableSnapshot(await service.getSnapshot());
    assert.equal(mergedBranchSnapshot.upstream, `origin/${branch}`);
    assert.equal(mergedBranchSnapshot.upstreamPublished, false);
    assert.equal(mergedBranchSnapshot.pullRequestBase, `origin/${baseBranch}`);
    assert.equal(mergedBranchSnapshot.pullRequestAhead, 0);
    runGit(directory, 'restore', 'alpha.txt');

    const status = await service.getPullRequestBranchCleanupStatus(pullRequestNumber);
    assert.equal(status.state, 'base-behind');
    assert.equal(status.canCleanup, true);
    assert.equal(status.currentBranch, branch);
    assert.equal(status.upstream, `origin/${baseBranch}`);
    assert.equal(status.baseAhead, 0);
    assert.equal(status.baseBehind, 2);
    assert.match(status.message, /main has 2 incoming commits from origin\/main/u);

    const result = await service.cleanupPullRequestBranch(pullRequestNumber);
    assert.equal(result.state, 'complete');
    assert.equal(result.updatedBase, true);
    assert.equal(availableSnapshot(result.snapshot).head, baseBranch);
    assert.equal(result.localBranchExists, false);
    assert.equal(
      runGit(directory, 'rev-parse', `refs/heads/${baseBranch}`).trim(),
      runGit(directory, 'rev-parse', `refs/remotes/origin/${baseBranch}`).trim(),
    );
    assert.throws(() => {
      runGit(directory, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    });
  } finally {
    rmSync(collaboratorDirectory, { recursive: true, force: true });
    rmSync(remoteDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('offers to republish local commits created after a pull request was merged', async () => {
  const fixture = createPullRequestCleanupFixture();
  const {
    branch,
    collaboratorDirectory,
    directory,
    fakeGitHubCli,
    pullRequestNumber,
    remoteDirectory,
  } = fixture;
  try {
    writeFileSync(path.join(directory, 'after-merge.txt'), 'new pull request work\n');
    runGit(directory, 'add', 'after-merge.txt');
    runGit(directory, 'commit', '-m', 'start follow up work');

    const service = new GitService({ workspaceRoot: directory, ghExecutable: fakeGitHubCli });
    const status = await service.getPullRequestBranchCleanupStatus(pullRequestNumber);
    assert.equal(status.state, 'local-commits-after-merge');
    assert.equal(status.canCleanup, false);
    assert.equal(status.canPush, true);
    assert.equal(status.branchAhead, 1);
    assert.match(status.message, /Push the branch to recreate its remote/u);

    const pushed = await service.pushCurrentBranch();
    assert.equal(availableSnapshot(pushed.snapshot).upstreamPublished, true);
    assert.equal(
      runGit(directory, 'rev-parse', branch).trim(),
      runGit(remoteDirectory, 'rev-parse', `refs/heads/${branch}`).trim(),
    );

    const publishedStatus = await service.getPullRequestBranchCleanupStatus(pullRequestNumber);
    assert.equal(publishedStatus.state, 'local-commits-after-merge');
    assert.equal(publishedStatus.canPush, false);
  } finally {
    rmSync(collaboratorDirectory, { recursive: true, force: true });
    rmSync(remoteDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recognizes the original local branch after a squash merge', async () => {
  const fixture = createPullRequestCleanupFixture({ squash: true });
  const {
    collaboratorDirectory,
    directory,
    fakeGitHubCli,
    pullRequestNumber,
    remoteDirectory,
  } = fixture;
  try {
    const service = new GitService({ workspaceRoot: directory, ghExecutable: fakeGitHubCli });
    const status = await service.getPullRequestBranchCleanupStatus(pullRequestNumber);
    assert.equal(status.state, 'base-behind');
    assert.equal(status.canCleanup, true);
    assert.equal(status.canPush, false);
    assert.equal(status.branchAhead, 0);
  } finally {
    rmSync(collaboratorDirectory, { recursive: true, force: true });
    rmSync(remoteDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('blocks local pull request cleanup when main has diverged from its remote', async () => {
  const fixture = createPullRequestCleanupFixture();
  const {
    baseBranch,
    collaboratorDirectory,
    directory,
    fakeGitHubCli,
    pullRequestNumber,
    remoteDirectory,
  } = fixture;
  try {
    runGit(directory, 'switch', baseBranch);
    writeFileSync(path.join(directory, 'local-main.txt'), 'local main change\n');
    runGit(directory, 'add', 'local-main.txt');
    runGit(directory, 'commit', '-m', 'local main change');
    runGit(directory, 'switch', 'feature/cleanup');

    const service = new GitService({ workspaceRoot: directory, ghExecutable: fakeGitHubCli });
    const status = await service.getPullRequestBranchCleanupStatus(pullRequestNumber);
    assert.equal(status.state, 'base-diverged');
    assert.equal(status.canCleanup, false);
    assert.equal(status.baseAhead, 1);
    assert.equal(status.baseBehind, 2);
    assert.match(status.message, /have diverged/u);
    await assert.rejects(
      service.cleanupPullRequestBranch(pullRequestNumber),
      /have diverged/u,
    );
    assert.equal(availableSnapshot(await service.getSnapshot()).head, 'feature/cleanup');
  } finally {
    rmSync(collaboratorDirectory, { recursive: true, force: true });
    rmSync(remoteDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reports malformed GitHub pull request lists as unavailable', async () => {
  const directory = createRepository();
  const fakeGitHubCli = path.join(directory, 'fake-invalid-gh');
  writeFileSync(fakeGitHubCli, `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '{}'
  exit 0
fi
exit 2
`);
  chmodSync(fakeGitHubCli, 0o755);

  try {
    const service = new GitService({ workspaceRoot: directory, ghExecutable: fakeGitHubCli });
    const result = await service.listPullRequests();
    assert.equal(result.available, false);
    assert.match(result.message, /invalid pull request list/u);
    assert.deepEqual(result.pullRequests, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('includes the Git service in packaged desktop applications', async () => {
  const configuration = await loadForgeConfiguration();
  const shouldIgnore = configuration.packagerConfig.ignore;
  if (typeof shouldIgnore !== 'function') throw new Error('Forge ignore configuration is unavailable.');
  assert.equal(shouldIgnore('/desktop/lib/git-service.mts'), false);
});

for (const changeKind of ['unstaged', 'staged', 'untracked']) {
  test(`blocks remote pull request branch deletion with ${changeKind} changes`, async () => {
    const fixture = createPullRequestCleanupFixture();
    const { directory, remoteDirectory, collaboratorDirectory, branch, fakeGitHubCli, pullRequestNumber } = fixture;
    try {
      runGit(directory, 'push', 'origin', branch);
      const file = changeKind === 'untracked' ? 'new.txt' : 'alpha.txt';
      writeFileSync(path.join(directory, file), 'unfinished work\n');
      if (changeKind === 'staged') runGit(directory, 'add', file);
      const service = new GitService({ workspaceRoot: directory, ghExecutable: fakeGitHubCli });
      const status = await service.getPullRequestBranchCleanupStatus(pullRequestNumber);
      assert.equal(status.state, 'worktree-dirty');
      assert.equal(status.canCleanup, false);
      assert.equal(status.canPush, false);
      await assert.rejects(service.deletePullRequestBranch(pullRequestNumber), /Commit or discard/u);
      runGit(remoteDirectory, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    } finally {
      rmSync(collaboratorDirectory, { recursive: true, force: true });
      rmSync(remoteDirectory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('offers unpushed postmerge work before remote deletion and protects published followups', async () => {
  const fixture = createPullRequestCleanupFixture();
  const { directory, remoteDirectory, collaboratorDirectory, branch, fakeGitHubCli, pullRequestNumber } = fixture;
  try {
    runGit(directory, 'push', 'origin', branch);
    const service = new GitService({ workspaceRoot: directory, ghExecutable: fakeGitHubCli });
    assert.equal((await service.getPullRequestBranchCleanupStatus(pullRequestNumber)).state, 'remote-branch-present');
    writeFileSync(path.join(directory, 'followup.txt'), 'followup work\n');
    runGit(directory, 'add', 'followup.txt');
    runGit(directory, 'commit', '-m', 'follow up after merge');
    const status = await service.getPullRequestBranchCleanupStatus(pullRequestNumber);
    assert.equal(status.state, 'local-commits-after-merge');
    assert.equal(status.canPush, true);
    assert.equal(status.canCleanup, false);
    assert.equal(status.branchAhead, 1);
    await assert.rejects(service.deletePullRequestBranch(pullRequestNumber), /outside the merged pull request/u);
    runGit(directory, 'switch', 'main');
    assert.equal((await service.getPullRequestBranchCleanupStatus(pullRequestNumber)).canPush, false);
    runGit(directory, 'switch', branch);
    await service.pushCurrentBranch();
    const published = await service.getPullRequestBranchCleanupStatus(pullRequestNumber);
    assert.equal(published.state, 'local-commits-after-merge');
    assert.equal(published.canPush, false);
    assert.match(published.message, /already pushed/u);
    await assert.rejects(service.deletePullRequestBranch(pullRequestNumber), /outside the merged pull request/u);
    const mergedHead = runGit(directory, 'rev-parse', 'HEAD~1').trim();
    runGit(directory, 'switch', 'main');
    runGit(directory, 'branch', '-f', branch, mergedHead);
    assert.equal((await service.getPullRequestBranchCleanupStatus(pullRequestNumber)).state, 'branch-not-merged');
    await assert.rejects(service.deletePullRequestBranch(pullRequestNumber), /outside the merged pull request/u);
    runGit(directory, 'switch', branch);
    writeFileSync(path.join(directory, 'cleanup.txt'), 'amended work outside merged head\n');
    runGit(directory, 'add', 'cleanup.txt');
    runGit(directory, 'commit', '--amend', '--no-edit');
    assert.equal((await service.getPullRequestBranchCleanupStatus(pullRequestNumber)).state, 'branch-not-merged');
    await assert.rejects(service.deletePullRequestBranch(pullRequestNumber), /outside the merged pull request/u);
    runGit(directory, 'switch', 'main');
    runGit(directory, 'branch', '-D', branch);
    await assert.rejects(service.deletePullRequestBranch(pullRequestNumber), /outside the merged pull request/u);
    runGit(remoteDirectory, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
  } finally {
    rmSync(collaboratorDirectory, { recursive: true, force: true });
    rmSync(remoteDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
