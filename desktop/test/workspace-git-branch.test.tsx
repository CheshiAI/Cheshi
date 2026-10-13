import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectGitBranch, ProjectGitFileCounts } from '../frontend/src/features/navigation/ProjectGitBranch';
import type { GitFileChange, GitRepositorySnapshot } from '../frontend/src/cheshiDesktop';
import {
  observeWorkspaceGitBranch,
  workspaceGitBranchLabels,
  workspaceGitFileCounts,
} from '../frontend/src/shared/workspaceGitBranchModel';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function branch(head: string): GitRepositorySnapshot {
  return { available: true, message: '', head, detached: false };
}

function observer() {
  const requests: ReturnType<typeof createDeferred<GitRepositorySnapshot>>[] = [];
  const values: (GitRepositorySnapshot | null)[] = [];
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  let listener = () => {};
  let unsubscribed = false;
  const close = observeWorkspaceGitBranch({
    getGitSnapshot: () => {
      const request = createDeferred<GitRepositorySnapshot>();
      requests.push(request);
      return request.promise;
    },
    onGitRepositoryChanged: handler => {
      listener = handler;
      return () => { unsubscribed = true; };
    },
  }, value => { values.push(value); }, { window, document });
  return { requests, values, window, document, close, change: () => listener(),
    get unsubscribed() { return unsubscribed; } };
}

test('reads the initial branch and refreshes on repository changes without the Git view', async () => {
  const app = observer();
  try {
    expect(app.requests).toHaveLength(1);
    app.requests[0]!.resolve(branch('main'));
    await app.requests[0]!.promise;
    expect(app.values.at(-1)?.head).toBe('main');
    app.change();
    app.requests[1]!.resolve(branch('feature/next'));
    await app.requests[1]!.promise;
    expect(app.values.at(-1)?.head).toBe('feature/next');
  } finally { app.close(); }
});

test('coalesces rapid switches and discards a stale startup response', async () => {
  const app = observer();
  try {
    app.change();
    app.change();
    expect(app.requests).toHaveLength(1);
    app.requests[0]!.resolve(branch('old'));
    await app.requests[0]!.promise;
    expect(app.values).toEqual([]);
    expect(app.requests).toHaveLength(2);
    app.change();
    app.requests[1]!.resolve(branch('intermediate'));
    await app.requests[1]!.promise;
    expect(app.values).toEqual([]);
    app.requests[2]!.resolve(branch('latest'));
    await app.requests[2]!.promise;
    expect(app.values.map(value => value?.head)).toEqual(['latest']);
  } finally { app.close(); }
});

test('rechecks on focus and becoming visible, with no hidden focus refresh', async () => {
  const app = observer();
  try {
    app.requests[0]!.resolve(branch('main'));
    await app.requests[0]!.promise;
    app.document.visibilityState = 'hidden';
    app.document.dispatchEvent(new Event('visibilitychange'));
    app.window.dispatchEvent(new Event('focus'));
    expect(app.requests).toHaveLength(1);
    app.document.visibilityState = 'visible';
    app.document.dispatchEvent(new Event('visibilitychange'));
    app.requests[1]!.resolve(branch('external-switch'));
    await app.requests[1]!.promise;
    expect(app.values.at(-1)?.head).toBe('external-switch');
    app.window.dispatchEvent(new Event('focus'));
    expect(app.requests).toHaveLength(3);
  } finally { app.close(); }
});

test('clears an unavailable branch and recovers after a later change', async () => {
  const app = observer();
  try {
    app.requests[0]!.resolve(branch('main'));
    await app.requests[0]!.promise;
    app.change();
    app.requests[1]!.reject(new Error('Git read failed'));
    await app.requests[1]!.promise.catch(() => {});
    expect(app.values.at(-1)).toBeNull();
    app.change();
    app.requests[2]!.resolve(branch('recovered'));
    await app.requests[2]!.promise;
    expect(app.values.at(-1)?.head).toBe('recovered');
  } finally { app.close(); }
});

test('does not publish an obsolete failure when a newer refresh is queued', async () => {
  const app = observer();
  try {
    app.change();
    app.requests[0]!.reject(new Error('Obsolete read failed'));
    await app.requests[0]!.promise.catch(() => {});
    expect(app.values).toEqual([]);
    app.requests[1]!.resolve(branch('latest'));
    await app.requests[1]!.promise;
    expect(app.values.at(-1)?.head).toBe('latest');
  } finally { app.close(); }
});

test('unsubscribes on disposal and ignores pending responses and events', async () => {
  const app = observer();
  app.change();
  app.close();
  app.requests[0]!.resolve(branch('late'));
  await app.requests[0]!.promise;
  app.window.dispatchEvent(new Event('focus'));
  app.document.dispatchEvent(new Event('visibilitychange'));
  app.change();
  expect(app.unsubscribed).toBe(true);
  expect(app.values).toEqual([]);
  expect(app.requests).toHaveLength(1);
});

test('distinguishes branch, detached HEAD, unborn repository and unavailable states', () => {
  expect(workspaceGitBranchLabels(branch('feature/long-branch')).label).toBe('feature/long-branch');
  expect(workspaceGitBranchLabels({ ...branch('abc1234'), detached: true }).label).toBe('Detached · abc1234');
  expect(workspaceGitBranchLabels({ available: true, message: '', head: null }).label).toBe('No branch');
  expect(workspaceGitBranchLabels({ available: false, message: 'Not a Git worktree' }))
    .toEqual({ label: 'Git unavailable', title: 'Not a Git worktree' });
  expect(workspaceGitBranchLabels(null).label).toBe('Git unavailable');
});

function fileChange(path: string, indexStatus = ' ', workingTreeStatus = 'M'): GitFileChange {
  return { path, oldPath: null, indexStatus, workingTreeStatus,
    staged: indexStatus !== ' ' && indexStatus !== '?',
    unstaged: workingTreeStatus !== ' ' && workingTreeStatus !== '?',
    untracked: indexStatus === '?' && workingTreeStatus === '?' };
}

test('counts changed files once across staged, unstaged, untracked, renamed and deleted changes', () => {
  const changes = [fileChange('modified.ts', 'M', 'M'), fileChange('new.ts', 'A', ' '),
    fileChange('untracked.ts', '?', '?'), { ...fileChange('renamed.ts', 'R', ' '), oldPath: 'old.ts' },
    fileChange('staged-delete.ts', 'D', ' '), fileChange('working-delete.ts', ' ', 'D'),
    fileChange('modified.ts'), fileChange('clean.ts', ' ', ' ')];
  expect(workspaceGitFileCounts({ ...branch('main'), changes })).toEqual({ changed: 4, deleted: 2 });
});

test('counts recreated paths as changed and hides unavailable or clean snapshots', () => {
  const changes = [fileChange('recreated.ts', 'D', ' '), fileChange('recreated.ts', '?', '?')];
  expect(workspaceGitFileCounts({ ...branch('main'), changes })).toEqual({ changed: 1, deleted: 0 });
  for (const snapshot of [null, branch('main'), { available: false, message: 'Unavailable', changes }]) {
    expect(workspaceGitFileCounts(snapshot)).toEqual({ changed: 0, deleted: 0 });
  }
});

test('project branch keeps full names for assistive text and omits unavailable repositories', () => {
  const snapshot = branch('feature/a-very-long-branch-name');
  const html = renderToStaticMarkup(<ProjectGitBranch snapshot={snapshot} />);
  expect(html).toContain('aria-label="Current Git branch: feature/a-very-long-branch-name"');
  expect(html).toContain('>feature/a-very-long-branch-name</span>');
  expect(html).toContain('data-tooltip-trigger');
  for (const value of [null, { available: false, message: 'Not a Git repository' }]) {
    expect(renderToStaticMarkup(<ProjectGitBranch snapshot={value} />)).toBe('');
  }
  expect(renderToStaticMarkup(<ProjectGitBranch snapshot={{ ...branch('abc1234'), detached: true }} />))
    .toContain('Detached · abc1234');
});

test('project counts retain file semantics and omit zero values', () => {
  const snapshot = { ...branch('main'), changes: [fileChange('one.ts'), fileChange('gone.ts', 'D', ' ')] };
  const html = renderToStaticMarkup(<ProjectGitFileCounts snapshot={snapshot} />);
  expect(html).toContain('1 added or modified files, 1 deleted files');
  expect(html).toContain('>+1</span>');
  expect(html).toContain('>−1</span>');
  const onlyAdded = renderToStaticMarkup(<ProjectGitFileCounts snapshot={{ ...snapshot, changes: [fileChange('one.ts')] }} />);
  expect(onlyAdded).toContain('>+1</span>');
  expect(onlyAdded).not.toContain('>−0</span>');
  const onlyDeleted = renderToStaticMarkup(<ProjectGitFileCounts snapshot={{ ...snapshot, changes: [fileChange('gone.ts', 'D', ' ')] }} />);
  expect(onlyDeleted).toContain('>−1</span>');
  expect(onlyDeleted).not.toContain('>+0</span>');
  expect(renderToStaticMarkup(<ProjectGitFileCounts snapshot={branch('main')} />)).toBe('');
});
