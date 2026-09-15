import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GitRepositorySnapshot } from '../frontend/src/cheshiDesktop';
import { parseStatus } from '../lib/git-parsers.mts';
import { observeWorkspaceGitStatus, workspaceGitChangedPaths } from '../frontend/src/shared/workspaceGitStatus';
import { observeWorkspaceGitBranch } from '../frontend/src/features/shell/workspaceGitBranchModel';
import { WorkspaceFileTreeRows } from '../frontend/src/features/navigation/WorkspaceFileTreeRows';
import type { WorkspaceFileTreeController } from '../frontend/src/features/navigation/useWorkspaceFileTreeController';

function snapshot(status: string): GitRepositorySnapshot {
  return { available: true, message: '', head: 'main', changes: parseStatus(status) };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('changed paths cover both Git columns, additions, untracked, renamed and conflicted files', () => {
  const result = workspaceGitChangedPaths(snapshot([
    ' M src/unstaged.ts', 'M  src/staged.ts', 'MM src/both.ts', 'A  src/added.ts',
    '?? src/new.ts', 'R  src/renamed.ts', 'src/old.ts', 'UU src/conflict.ts',
    ' D src/deleted.ts', '!! ignored.ts', '   clean.ts', '',
  ].join('\0')));
  expect([...result]).toEqual(['src/unstaged.ts', 'src/staged.ts', 'src/both.ts', 'src/added.ts',
    'src/new.ts', 'src/renamed.ts', 'src/conflict.ts', 'src/deleted.ts']);
  expect(result.has('src')).toBe(false);
  expect(result.has('src/old.ts')).toBe(false);
  expect(workspaceGitChangedPaths(snapshot('')).size).toBe(0);
  expect(workspaceGitChangedPaths(null).size).toBe(0);
  expect(workspaceGitChangedPaths({ ...snapshot('M  stale.ts\0'), available: false }).size).toBe(0);
});

test('branch and Explorer share reads, replay current state and release it after the last unsubscribe', async () => {
  const requests: ReturnType<typeof createDeferred<GitRepositorySnapshot>>[] = [];
  const listeners = new Set<() => void>();
  const desktop = {
    getGitSnapshot: () => {
      const request = createDeferred<GitRepositorySnapshot>();
      requests.push(request);
      return request.promise;
    },
    onGitRepositoryChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const events = { window: new EventTarget(),
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState }) };
  const branch: (GitRepositorySnapshot | null)[] = [];
  const paths: ReadonlySet<string>[] = [];
  const closeBranch = observeWorkspaceGitBranch(desktop, value => { branch.push(value); }, events);
  const closeExplorer = observeWorkspaceGitStatus(desktop, value => { paths.push(workspaceGitChangedPaths(value)); }, events);
  expect(requests).toHaveLength(1);
  expect(listeners.size).toBe(1);
  requests[0]!.resolve(snapshot(' M src/a.ts\0'));
  await requests[0]!.promise;
  expect(paths.at(-1)?.has('src/a.ts')).toBe(true);
  expect(branch.at(-1)?.head).toBe('main');
  const late: (GitRepositorySnapshot | null)[] = [];
  const closeLate = observeWorkspaceGitStatus(desktop, value => { late.push(value); }, events);
  expect(late).toEqual([branch.at(-1)!]);
  expect(requests).toHaveLength(1);
  closeLate();
  closeBranch();
  expect(listeners.size).toBe(1);
  for (const listener of listeners) listener();
  requests[1]!.resolve(snapshot('M  src/a.ts\0'));
  await requests[1]!.promise;
  expect(paths.at(-1)?.has('src/a.ts')).toBe(true);
  for (const listener of listeners) listener();
  requests[2]!.resolve(snapshot(''));
  await requests[2]!.promise;
  expect(paths.at(-1)?.size).toBe(0);
  expect(branch).toHaveLength(1);
  closeExplorer();
  closeExplorer();
  expect(listeners.size).toBe(0);
  const remounted: (GitRepositorySnapshot | null)[] = [];
  const closeRemounted = observeWorkspaceGitStatus(desktop, value => { remounted.push(value); }, events);
  expect(requests).toHaveLength(4);
  expect(remounted).toEqual([]);
  closeRemounted();
  requests[3]!.resolve(snapshot('M  late.ts\0'));
  await requests[3]!.promise;
  expect(remounted).toEqual([]);
});

test('Explorer marks only changed file names and removes marks when the status clears', () => {
  // The controller boundary supplies only fields used by the read-only rows in this fixture.
  const controller = {
    expandedDirectories: new Set(['src']), gitChangedPaths: new Set(['src', 'src/changed.ts']),
    visibleEntries: [
      { entry: { path: 'src', name: 'src', kind: 'directory' }, depth: 0 },
      { entry: { path: 'src/changed.ts', name: 'changed.ts', kind: 'file' }, depth: 1 },
      { entry: { path: 'src/clean.ts', name: 'clean.ts', kind: 'file' }, depth: 1 },
    ],
  } as unknown as WorkspaceFileTreeController;
  for (const selectedPath of [null, 'src/changed.ts']) {
    const markup = renderToStaticMarkup(<WorkspaceFileTreeRows controller={controller} selectedPath={selectedPath} />);
    expect(markup.match(/data-git-changed="true"/g)).toHaveLength(1);
    expect(markup).toContain('class="workspace-file-tree-name" data-git-changed="true"><span');
    expect(markup).not.toMatch(/<(button|svg)[^>]*data-git-changed/);
    expect(markup.match(/role="treeitem"/g)).toHaveLength(3);
    expect(markup.includes('aria-selected="true"')).toBe(selectedPath !== null);
  }
  controller.gitChangedPaths = new Set();
  expect(renderToStaticMarkup(<WorkspaceFileTreeRows controller={controller} selectedPath="src/changed.ts" />))
    .not.toContain('data-git-changed');
});
