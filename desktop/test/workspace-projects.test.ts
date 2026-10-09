import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink as createSymbolicLink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { WorkspaceProjectStore } from '../lib/workspace-project-store.mts';
import { mapProjectPaths, projectForPath, relativeProjectPath } from '../lib/workspace-project-paths.mts';
import { createWorkspaceProjects } from '../lib/workspace-project-runtime.mts';
import { registerWorkspaceFileIpcHandlers } from '../lib/workspace-file-ipc.mts';
import { registerGitIpcHandlers } from '../lib/git-ipc.mts';
import { GitService } from '../lib/git-service.mts';
import { parseEditorSession } from '../shared/editor-session';
import { workspaceFileSearchResult } from '../shared/workspace-file-search';
import { projectGitApi } from '../frontend/src/shared/workspaceProjects';
import type { CheshiDesktopApi } from '../frontend/src/cheshiDesktop';
import { TerminalController } from '../lib/terminal-controller.mts';
import { registerWorkspaceTerminalIpc } from '../lib/workspace-terminal-ipc.mts';

async function rejected(operation: Promise<unknown>, pattern: RegExp) {
  let error: unknown;
  try { await operation; } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(pattern);
}

async function fixture(run: (directories: { base: string; root: string; linked: string; data: string }) => Promise<void>) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'cheshi-projects-')));
  const directories = { base, root: path.join(base, 'app'), linked: path.join(base, 'plugin'), data: path.join(base, 'data') };
  await Promise.all([mkdir(directories.root), mkdir(directories.linked)]);
  try { await run(directories); } finally { await rm(base, { recursive: true, force: true }); }
}

test('membership restores independent roots and removing a link preserves source files', async () => {
  await fixture(async ({ root, linked, data }) => {
    const store = new WorkspaceProjectStore(data, root);
    expect(store.list().map(project => project.rootPath)).toEqual([root]);
    await writeFile(path.join(linked, 'source.ts'), 'keep');
    const added = await store.add(linked);
    expect(added).toHaveLength(2);
    expect(await store.add(linked)).toHaveLength(2);
    expect(new WorkspaceProjectStore(data, root).list()).toEqual(added);
    expect(() => store.remove('primary')).toThrow('primary');
    store.remove(added[1]!.id);
    expect(store.list()).toHaveLength(1);
    expect(await readFile(path.join(linked, 'source.ts'), 'utf8')).toBe('keep');
  });
});

test('membership rejects overlapping roots and deduplicates symlink aliases', async () => {
  await fixture(async ({ base, root, linked, data }) => {
    const store = new WorkspaceProjectStore(data, root);
    await rejected(store.add(base), /overlaps/);
    const child = path.join(root, 'nested');
    await mkdir(child);
    await rejected(store.add(child), /overlaps/);
    await store.add(linked);
    const alias = path.join(base, 'alias');
    await createSymbolicLink(linked, alias);
    expect(await store.add(alias)).toHaveLength(2);
    await rm(linked, { recursive: true });
    expect(store.list()[1]?.available).toBe(false);
    store.remove(store.list()[1]!.id);
    expect(store.list()).toHaveLength(1);
  });
});

test('paths select their own root and never reinterpret contents as paths', async () => {
  await fixture(async ({ root, linked, data }) => {
    const store = new WorkspaceProjectStore(data, root);
    const projects = await store.add(linked);
    expect(projectForPath(projects, 'same.ts').primary).toBe(true);
    expect(projectForPath(projects, path.join(linked, 'same.ts')).id).toBe(projects[1]!.id);
    expect(() => projectForPath(projects, `${linked}-other/same.ts`)).toThrow('outside');
    expect(() => projectForPath(projects, `${linked}/../plugin/same.ts`)).toThrow('Invalid');
    expect(() => relativeProjectPath(projects[1]!, path.join(root, 'same.ts'))).toThrow();
    expect(mapProjectPaths({ path: 'same.ts', content: 'same.ts', files: [{ path: 'other.ts' }] }, file => `${linked}/${file}`))
      .toEqual({ path: `${linked}/same.ts`, content: 'same.ts', files: [{ path: `${linked}/other.ts` }] });
  });
});

test('IPC isolates same-name files and Git operations, and revokes disconnected paths', async () => {
  await fixture(async ({ root, linked, data }) => {
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
    const ipc: Pick<IpcMain, 'handle'> = { handle: (channel, handler) => { handlers.set(channel, handler); } };
    const shell = { trashItem: async () => {}, openExternal: async () => {} };
    let allowed = true;
    let chatActive = false;
    const assertSender = () => { if (!allowed) throw new Error('Unauthorized'); };
    const runtime = createWorkspaceProjects({ ipc, root, dataRoot: data, clipboard: { writeText() {} }, shell,
      languageOptions: { settingsPath: path.join(data, 'languages.json'), clientInfo: { name: 'test', version: '1' } },
      assertSender, assertIdle() { if (chatActive) throw new Error('Chat is active'); }, chooseDirectory: async () => linked, emit() {} });
    const terminal = new TerminalController({ onStateChanged() {} });
    terminal.open(root);
    registerWorkspaceTerminalIpc({ ipc, projects: runtime.store, controller: () => terminal,
      available: () => true, snapshot: () => terminal.snapshot(), assertSender });
    const git = new GitService({ workspaceRoot: root });
    registerWorkspaceFileIpcHandlers({ ipcMain: runtime.ipc, workspaceRoot: root, clipboard: { writeText() {} }, shell });
    registerGitIpcHandlers({ ipcMain: runtime.ipc, gitService: git, assertCheshiSender: assertSender, shell });
    const invoke = async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(`cheshi:${channel}`);
      if (!handler) throw new Error('Missing handler');
      return handler({} as IpcMainInvokeEvent, ...args);
    };
    try {
      await Promise.all([writeFile(path.join(root, 'same.ts'), 'app'), writeFile(path.join(linked, 'same.ts'), 'plugin')]);
      const projects = await invoke('workspace-projects:add');
      const plugin = projects[1];
      await invoke('new-terminal-session', plugin.id);
      const pane = terminal.snapshot().sessions.at(-1)!.panes[0]!;
      expect(terminal.findPane(pane.id)?.cwd).toBe(linked);
      const original = await invoke('read-workspace-file', 'same.ts');
      const external = await invoke('read-workspace-file', path.join(linked, 'same.ts'));
      expect(original.content).toBe('app');
      expect(original.file.path).toBe('same.ts');
      expect(external.content).toBe('plugin');
      expect(external.file.path).toBe(path.join(linked, 'same.ts'));
      const written = await invoke('write-workspace-file', { path: external.file.path, content: 'updated', expectedRevision: external.file.revision });
      expect(written.file.path).toBe(external.file.path);
      expect(await readFile(path.join(root, 'same.ts'), 'utf8')).toBe('app');
      expect(await readFile(path.join(linked, 'same.ts'), 'utf8')).toBe('updated');
      await rejected(invoke('move-workspace-entry', { path: external.file.path, destinationDirectory: root }), /escapes/);
      await rejected(invoke('read-workspace-file', null), /strings/);
      await rejected(invoke('write-workspace-files', { files: [
        { path: external.file.path, content: 'bad', expectedRevision: written.file.revision },
        { path: 'same.ts', content: 'bad', expectedRevision: original.file.revision },
      ] }), /separately/);
      const search = workspaceFileSearchResult(await invoke('search-workspace-files', 'same'), true);
      expect(search.files.map(file => file.path).sort()).toEqual(['same.ts', path.join(linked, 'same.ts')].sort());
      await git.runGit(['init', '-q']);
      const linkedGit = new GitService({ workspaceRoot: linked });
      await linkedGit.runGit(['init', '-q']);
      await invoke('workspace-projects:invoke', plugin.id, 'cheshi:stage-git-paths', [['same.ts']]);
      const mainSnapshot = await git.getSnapshot(), linkedSnapshot = await linkedGit.getSnapshot();
      expect(mainSnapshot.available && mainSnapshot.changes[0]?.staged).toBe(false);
      expect(linkedSnapshot.available && linkedSnapshot.changes[0]?.staged).toBe(true);
      await rejected(invoke('workspace-projects:invoke', plugin.id, 'cheshi:delete-workspace-entry', ['same.ts']), /Invalid/);
      allowed = false;
      await rejected(invoke('read-workspace-file', external.file.path), /Unauthorized/);
      allowed = true;
      chatActive = true;
      await rejected(invoke('workspace-projects:remove', plugin.id), /Chat is active/);
      expect(runtime.store.list()).toHaveLength(2);
      chatActive = false;
      await invoke('workspace-projects:remove', plugin.id);
      await rejected(invoke('new-terminal-session', plugin.id), /not connected/);
      await rejected(invoke('read-workspace-file', external.file.path), /outside/);
      await rejected(invoke('workspace-projects:invoke', plugin.id, 'cheshi:get-git-snapshot', []), /not connected/);
    } finally { await runtime.dispose(); }
  });
});

test('editor session paths retain project identity and reject traversal', () => {
  const paths = ['same.ts', '/projects/plugin/same.ts'];
  expect(parseEditorSession({ version: 1, paths, selectedPath: paths[1] }).paths).toEqual(paths);
  expect(() => parseEditorSession({ version: 1, paths: ['/projects/plugin/../other.ts'], selectedPath: null })).toThrow();
});

test('Git adapter binds asynchronous requests to its project without mutable global selection', async () => {
  const calls: unknown[][] = [];
  const base = { workspaceProjects: { invoke: async (...args: unknown[]) => { calls.push(args); return {}; } } } as unknown as CheshiDesktopApi;
  const project = { id: 'plugin', name: 'Plugin', rootPath: '/plugin', primary: false, available: true };
  const api = projectGitApi(base, project)!;
  await api.getGitSnapshot();
  await api.getGitHubPullRequestDetails(3);
  await api.stageGitPaths(['file.ts']);
  expect(calls).toEqual([
    ['plugin', 'cheshi:get-git-snapshot', []],
    ['plugin', 'cheshi:get-github-pull-request-details', [3]],
    ['plugin', 'cheshi:stage-git-paths', [['file.ts']]],
  ]);
});
