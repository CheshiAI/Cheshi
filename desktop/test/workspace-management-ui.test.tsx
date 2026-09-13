import { createGitHubLoginApi } from './github-login-fixture';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { canOpenWorkspaceWorktrees, filterWorkspaceEntries, runWorkspaceDeletion, WorkspaceManager, WorkspaceProjectList } from '../frontend/src/features/navigation/workspace-management/WorkspaceManager';
import type { WorkspaceCatalogEntry, WorkspaceManagementApi } from '../shared/workspace-management';
import { childDirectory, parentDirectory, repositoryDirectoryName, validDirectoryName } from '../frontend/src/features/navigation/workspace-management/workspace-paths';
import { runWorkspaceOperation, type WorkspaceOperationState } from '../frontend/src/features/navigation/workspace-management/workspace-operation';
import { runWorkspaceOpenChoice, WorkspaceOpenChoices } from '../frontend/src/features/navigation/workspace-management/OpenWorkspaceDialog';

const entry = { id: 'project', name: 'Project', rootPath: '/work/project', available: true };

function createDeferred() {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('opening failure preserves completed clone for retry without creating twice', async () => {
  const state: WorkspaceOperationState = { pending: false, completed: null };
  let creates = 0;
  let opens = 0;
  const create = async () => { creates += 1; return entry; };
  const open = async () => { opens += 1; if (opens === 1) throw new Error('Window unavailable'); };
  let rejected: unknown;
  try { await runWorkspaceOperation(state, create, open, () => {}); }
  catch (error) { rejected = error; }
  expect(rejected).toBeInstanceOf(Error);
  expect(state.completed).toEqual(entry);
  expect(state.pending).toBe(false);
  expect(await runWorkspaceOperation(state, create, open, () => {})).toBe(true);
  expect(creates).toBe(1);
  expect(opens).toBe(2);
});

test('duplicate submission cannot create another workspace while operation is pending', async () => {
  const gate = createDeferred();
  const state: WorkspaceOperationState = { pending: false, completed: null };
  let creates = 0;
  const create = async () => { creates += 1; await gate.promise; return entry; };
  const first = runWorkspaceOperation(state, create, async () => {}, () => {});
  expect(await runWorkspaceOperation(state, create, async () => {}, () => {})).toBe(false);
  gate.resolve();
  expect(await first).toBe(true);
  expect(creates).toBe(1);
});

test('failed creation is retryable and never attempts opening', async () => {
  const state: WorkspaceOperationState = { pending: false, completed: null };
  let opens = 0;
  let rejected: unknown;
  try { await runWorkspaceOperation(state, async () => { throw new Error('Clone failed'); }, async () => { opens += 1; }, () => {}); }
  catch (error) { rejected = error; }
  expect(rejected).toBeInstanceOf(Error);
  expect(state).toEqual({ pending: false, completed: null });
  expect(opens).toBe(0);
});

test('repository names and sibling previews support HTTPS, SSH and Windows paths', () => {
  expect(repositoryDirectoryName('git@github.com:owner/project.git')).toBe('project');
  expect(repositoryDirectoryName('https://github.com/owner/project.git')).toBe('project');
  expect(childDirectory(parentDirectory('/work/project'), 'project-task')).toBe('/work/project-task');
  expect(childDirectory(parentDirectory('/project'), 'task')).toBe('/task');
  expect(childDirectory(parentDirectory('C:\\work\\project'), 'task')).toBe('C:\\work\\task');
  expect(childDirectory(parentDirectory('C:\\project'), 'task')).toBe('C:\\task');
  expect(parentDirectory('/')).toBe('/');
  expect(parentDirectory('C:\\')).toBe('C:\\');
  expect(parentDirectory('C:/')).toBe('C:/');
  for (const value of ['', '.', '..', ' .. ', ' . ', '../task', 'nested/task', 'nested\\task', '-option', ' -option ', 'C:task']) expect(validDirectoryName(value)).toBe(false);
});

test('project search matches names and full paths without changing catalog order', () => {
  const entries = [entry, { ...entry, id: 'other', name: 'Other', rootPath: '/work/team-tools' }];
  expect(filterWorkspaceEntries(entries, '  PROJECT  ')).toEqual([entry]);
  expect(filterWorkspaceEntries(entries, 'TEAM-TOOLS')).toEqual([entries[1]!]);
  expect(filterWorkspaceEntries(entries, ' ')).toEqual(entries);
  expect(filterWorkspaceEntries(entries, 'missing')).toEqual([]);
});

test('unavailable projects remain visible but cannot be opened', () => {
  const html = renderToStaticMarkup(<WorkspaceProjectList
    entries={[entry, { ...entry, id: 'missing', name: 'Missing', rootPath: '/missing', available: false }]}
    selectedPath={entry.rootPath} busy={false} onSelect={() => {}} onOpen={() => {}} onDelete={() => {}} />);
  expect(html).toContain('Open Project');
  expect(html).toContain('Open Missing — unavailable');
  expect(html).toContain('Folder unavailable');
  expect(html.match(/disabled=""/g)).toHaveLength(1);
  expect(html).toContain('/missing');
  expect(html).toContain('Delete Missing workspace and folder');
  expect(html.match(/<button\b/g)).toHaveLength(4);
  expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
});

test('worktrees require confirmed Git capability for the actual context rather than another catalog project', () => {
  const git = { ...entry, isGitRepository: true };
  const plain = { ...entry, id: 'plain', rootPath: '/work/plain', isGitRepository: false };
  expect(canOpenWorkspaceWorktrees([git, plain], git.rootPath, false)).toBe(true);
  expect(canOpenWorkspaceWorktrees([git, plain], plain.rootPath, false)).toBe(false);
  expect(canOpenWorkspaceWorktrees([git], '/work/missing', false)).toBe(false);
  expect(canOpenWorkspaceWorktrees([entry], entry.rootPath, false)).toBe(false);
  expect(canOpenWorkspaceWorktrees([{ ...git, available: false }], git.rootPath, false)).toBe(false);
  const malformed = { ...git, isGitRepository: 'true' } as unknown as WorkspaceCatalogEntry;
  expect(canOpenWorkspaceWorktrees([malformed], git.rootPath, false)).toBe(false);
});

test('loading, failed refresh or busy state blocks previously confirmed Git capability', () => {
  const git = { ...entry, isGitRepository: true };
  expect(canOpenWorkspaceWorktrees([git], git.rootPath, true)).toBe(false);
  expect(canOpenWorkspaceWorktrees([], git.rootPath, true)).toBe(false);
});

test('manager gates project actions behind tool and authentication checks without mounting conversation UI', () => {
  const api: WorkspaceManagementApi = {
  ...createGitHubLoginApi(),
    getCodexLogin: async () => ({ state: 'signed_in', error: null }),
    startCodexLogin: async () => ({ state: 'signing_in', error: null }),
    cancelCodexLogin: async () => ({ state: 'signed_out', error: null }),
    getToolStatus: async () => ({ platform: 'darwin', brew: true, gh: true, codex: true }),
    list: async () => ({ workspaces: [] }), chooseDirectory: async () => null,
    deleteWorkspace: async () => false,
    listGitHubRepositories: async () => ({ login: 'test', repositories: [], nextPage: null }),
    addFolder: async () => entry, createProject: async () => entry, clone: async () => entry, listWorktrees: async () => [],
    createWorktree: async () => entry, open: async () => {}, openCurrent: async () => {}, openManager: async () => {},
  };
  const initialMac = renderToStaticMarkup(<WorkspaceManager api={api} workspaceName="Project" workspaceRoot="/work/project" platform="darwin" />);
  expect(initialMac).toContain('Checking installed tools');
  expect(initialMac).not.toContain('Search projects');
  expect(initialMac).not.toContain('Open folder');
  expect(initialMac).not.toContain('Your next workspace starts here');
  const html = renderToStaticMarkup(<WorkspaceManager api={api} workspaceName="Project" workspaceRoot="/work/project" platform="win32" />);
  expect(html).toContain('Checking Codex sign-in');
  expect(html).not.toContain('Search projects');
  expect(html).not.toContain('Open folder');
  expect(html).not.toContain('Clone repository');
  expect(html).not.toContain('Git worktrees');
  expect(html).toContain('Workspaces');
  expect(html).not.toContain('Pending thread');
  expect(html).not.toContain('SSH');
});

test('workspace deletion keeps cancelled or failed entries and removes only confirmed successful entries', async () => {
  const pending = { current: false };
  const calls: string[] = [];
  let removed = 0;
  const onDeleted = () => { removed += 1; };
  expect(await runWorkspaceDeletion(pending, { deleteWorkspace: async (id) => { calls.push(id); return false; } }, entry.id, onDeleted)).toBe(false);
  expect(removed).toBe(0);
  let rejected: unknown;
  try { await runWorkspaceDeletion(pending, { deleteWorkspace: async () => { throw new Error('Close this workspace first.'); } }, entry.id, onDeleted); }
  catch (error) { rejected = error; }
  expect(rejected).toBeInstanceOf(Error);
  expect(removed).toBe(0);
  expect(pending.current).toBe(false);
  expect(await runWorkspaceDeletion(pending, { deleteWorkspace: async (id) => { calls.push(id); return true; } }, entry.id, onDeleted)).toBe(true);
  expect(removed).toBe(1);
  expect(calls).toEqual([entry.id, entry.id]);
});

test('workspace deletion blocks repeat submissions while the native confirmation is pending', async () => {
  const gate = createDeferred();
  const pending = { current: false };
  let attempts = 0;
  let removed = 0;
  const api = { deleteWorkspace: async () => { attempts += 1; await gate.promise; return true; } };
  const onDeleted = () => { removed += 1; };
  const first = runWorkspaceDeletion(pending, api, entry.id, onDeleted);
  expect(await runWorkspaceDeletion(pending, api, entry.id, onDeleted)).toBe(false);
  expect(attempts).toBe(1);
  gate.resolve();
  expect(await first).toBe(true);
  expect(removed).toBe(1);
  expect(pending.current).toBe(false);
});

test('busy project lists disable deletion as well as opening', () => {
  const html = renderToStaticMarkup(<WorkspaceProjectList entries={[entry]} selectedPath={entry.rootPath}
    busy onSelect={() => {}} onOpen={() => {}} onDelete={() => {}} />);
  expect(html.match(/disabled=""/g)).toHaveLength(2);
});

test('current workspace disables only this window while another workspace enables both choices', () => {
  const renderChoices = (currentPath: string, busy = false) => renderToStaticMarkup(
    <WorkspaceOpenChoices entry={entry} currentPath={currentPath} busy={busy} error={null} onOpen={() => {}} />,
  );
  const current = renderChoices(entry.rootPath);
  expect(current).toMatch(/<button[^>]*disabled=""[^>]*>Open in this window<\/button>/);
  expect(current).toMatch(/<button(?![^>]*disabled)[^>]*>Open in new window<\/button>/);
  expect(renderChoices('/work/other')).not.toContain('disabled=""');
  expect(renderChoices('/work/other', true).match(/disabled=""/g)).toHaveLength(2);
});

test('workspace choices route to the selected destination and reject a same-workspace replacement', async () => {
  const calls: string[] = [];
  const api = {
    open: async (path: string) => { calls.push(`new:${path}`); },
    openCurrent: async (path: string) => { calls.push(`current:${path}`); },
  };
  const state = { pending: false };
  expect(await runWorkspaceOpenChoice(state, api, entry.rootPath, entry.rootPath, 'current')).toBe(false);
  expect(calls).toEqual([]);
  expect(await runWorkspaceOpenChoice(state, api, entry.rootPath, entry.rootPath, 'new')).toBe(true);
  expect(await runWorkspaceOpenChoice(state, api, entry.rootPath, '/work/other', 'current')).toBe(true);
  expect(calls).toEqual([`new:${entry.rootPath}`, `current:${entry.rootPath}`]);
});

test('workspace choice blocks concurrent launches and permits retry after failure', async () => {
  const gate = createDeferred();
  let attempts = 0;
  const api = {
    open: async () => { attempts += 1; await gate.promise; throw new Error('Window unavailable'); },
    openCurrent: async () => { attempts += 1; },
  };
  const state = { pending: false };
  const first = runWorkspaceOpenChoice(state, api, entry.rootPath, '/work/other', 'new');
  expect(await runWorkspaceOpenChoice(state, api, entry.rootPath, '/work/other', 'current')).toBe(false);
  gate.resolve();
  let rejected: unknown;
  try { await first; } catch (error) { rejected = error; }
  expect(rejected).toBeInstanceOf(Error);
  expect(state.pending).toBe(false);
  expect(await runWorkspaceOpenChoice(state, api, entry.rootPath, '/work/other', 'current')).toBe(true);
  expect(attempts).toBe(2);
});
