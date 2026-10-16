import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CheshiDesktopApi, GitRepositorySnapshot, WorkspaceFilesChangedEvent } from '../frontend/src/cheshiDesktop';
import { parseStatus } from '../lib/git-parsers.mts';
import { observeWorkspaceGitStatus, workspaceGitChangedPaths } from '../frontend/src/shared/workspaceGitStatus';
import { observeWorkspaceGitBranch, workspaceGitFileCounts } from '../frontend/src/shared/workspaceGitBranchModel';
import { projectGitApi } from '../frontend/src/shared/workspaceProjects';
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

function createFileEvents() {
  const listeners = new Set<(event: WorkspaceFilesChangedEvent) => void>();
  return {
    listeners,
    subscribe(listener: (event: WorkspaceFilesChangedEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(paths: string[], overflow = false) {
      for (const listener of listeners) listener({ paths, overflow });
    },
  };
}

function visibilityEvents() {
  return { window: new EventTarget(),
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState }) };
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
  const files = createFileEvents();
  const desktop = {
    onWorkspaceFilesChanged: files.subscribe,
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
  expect(files.listeners.size).toBe(1);
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
  expect(files.listeners.size).toBe(0);
  const remounted: (GitRepositorySnapshot | null)[] = [];
  const closeRemounted = observeWorkspaceGitStatus(desktop, value => { remounted.push(value); }, events);
  expect(requests).toHaveLength(4);
  expect(remounted).toEqual([]);
  closeRemounted();
  requests[3]!.resolve(snapshot('M  late.ts\0'));
  await requests[3]!.promise;
  expect(remounted).toEqual([]);
});

test('external file deletion and rollback clear counts, including changes during an in-flight read', async () => {
  const files = createFileEvents();
  const requests: ReturnType<typeof createDeferred<GitRepositorySnapshot>>[] = [];
  const counts: number[] = [];
  const close = observeWorkspaceGitStatus({
    workspaceRoot: '/app', onWorkspaceFilesChanged: files.subscribe,
    onGitRepositoryChanged: () => () => {},
    getGitSnapshot: () => {
      const request = createDeferred<GitRepositorySnapshot>();
      requests.push(request);
      return request.promise;
    },
  }, value => { counts.push(workspaceGitFileCounts(value).changed); }, visibilityEvents());
  try {
    requests[0]!.resolve(snapshot(Array.from({ length: 25 }, (_, index) => `?? reports/${index}.png\0`).join('')));
    await requests[0]!.promise;
    expect(counts).toEqual([25]);
    files.emit(['reports']);
    expect(requests).toHaveLength(2);
    requests[1]!.resolve(snapshot(''));
    await requests[1]!.promise;
    expect(counts).toEqual([25, 0]);

    files.emit(['instructions.md']);
    files.emit(['instructions.md']);
    files.emit(['agent.json']);
    expect(requests).toHaveLength(3);
    requests[2]!.resolve(snapshot(' M instructions.md\0'));
    await requests[2]!.promise;
    expect(counts).toEqual([25, 0]);
    expect(requests).toHaveLength(4);
    requests[3]!.resolve(snapshot(''));
    await requests[3]!.promise;
    expect(counts).toEqual([25, 0, 0]);
  } finally { close(); }
  expect(files.listeners.size).toBe(0);
  files.emit(['late.ts']);
  expect(requests).toHaveLength(4);
});

for (const root of ['/projects', 'C:\\projects']) {
  test(`file events refresh only their project and recover from overflow under ${root}`, async () => {
    const files = createFileEvents();
    const reads = { primary: 0, atlas: 0 };
    const base = {
      workspaceRoot: `${root}/app`, onWorkspaceFilesChanged: files.subscribe,
      onGitRepositoryChanged: () => () => {},
      getGitSnapshot: async () => { reads.primary++; return snapshot(''); },
      workspaceProjects: {
        invoke: async (id: string) => {
          expect(id).toBe('atlas');
          reads.atlas++;
          return snapshot('');
        },
      },
    } as unknown as CheshiDesktopApi;
    const primary = { id: 'primary', name: 'App', rootPath: `${root}/app`, primary: true, available: true };
    const atlas = { id: 'atlas', name: 'Atlas', rootPath: `${root}/atlas`, primary: false, available: true };
    expect(projectGitApi(base, primary)).toBe(base);
    const closePrimary = observeWorkspaceGitStatus(base, () => {}, visibilityEvents());
    const closeAtlas = observeWorkspaceGitStatus(projectGitApi(base, atlas)!, () => {}, visibilityEvents());
    try {
      await Promise.resolve();
      expect(reads).toEqual({ primary: 1, atlas: 1 });
      files.emit(['src/main.ts']);
      await Promise.resolve();
      expect(reads).toEqual({ primary: 2, atlas: 1 });
      files.emit([`${root}/atlas/reports`]);
      await Promise.resolve();
      expect(reads).toEqual({ primary: 2, atlas: 2 });
      files.emit([`${root}/atlas-other/report.png`]);
      files.emit([]);
      await Promise.resolve();
      expect(reads).toEqual({ primary: 2, atlas: 2 });
      files.emit(['src/main.ts', `${root}/atlas/agent.json`]);
      await Promise.resolve();
      expect(reads).toEqual({ primary: 3, atlas: 3 });
      files.emit([], true);
      await Promise.resolve();
      expect(reads).toEqual({ primary: 4, atlas: 4 });
    } finally { closePrimary(); closeAtlas(); }
    expect(files.listeners.size).toBe(0);
  });
}

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
    expect(markup.match(/class="workspace-file-tree-guide"/g)).toHaveLength(5);
    expect(markup.match(/class="workspace-file-tree-icon workspace-file-type-icon"/g)).toHaveLength(2);
    expect(markup.match(/<img[^>]+src="[^"]*typeScript\.svg/g)).toHaveLength(2);
    expect(markup.includes('aria-selected="true"')).toBe(selectedPath !== null);
  }
  controller.gitChangedPaths = new Set();
  expect(renderToStaticMarkup(<WorkspaceFileTreeRows controller={controller} selectedPath="src/changed.ts" />))
    .not.toContain('data-git-changed');
});
