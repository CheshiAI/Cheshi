import { createGitHubLoginApi } from './github-login-fixture';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitFork } from 'lucide-react';
import type { WorkspaceManagementApi } from '../shared/workspace-management';
import { CloneWorkspacePage, CloneWorkspaceProgress } from '../frontend/src/features/navigation/workspace-management/CloneWorkspacePage';
import { PrepareCloneWorkspacePage } from '../frontend/src/features/navigation/workspace-management/PrepareCloneWorkspacePage';
import { WorkspaceManagerHeader } from '../frontend/src/features/navigation/workspace-management/WorkspaceManagerHeader';
import { WorktreeWorkspacePage } from '../frontend/src/features/navigation/workspace-management/WorktreeWorkspacePage';

const entry = { id: 'project', name: 'Project', rootPath: '/work/project', available: true };
const api: WorkspaceManagementApi = {
  getCodexLogin: async () => ({ state: 'signed_in', error: null }),
    startCodexLogin: async () => ({ state: 'signing_in', error: null }),
    cancelCodexLogin: async () => ({ state: 'signed_out', error: null }),
    getToolStatus: async () => ({ platform: 'darwin', brew: true, gh: true, codex: true }),
  ...createGitHubLoginApi(),
  openManager: async () => {},
  list: async () => ({ workspaces: [entry] }),
  chooseDirectory: async () => null,
  addFolder: async () => entry,
  createProject: async () => entry,
  deleteWorkspace: async () => false,
  clone: async () => entry,
  listGitHubRepositories: async () => ({ login: 'owner', repositories: [], nextPage: null }),
  listWorktrees: async () => [],
  createWorktree: async () => entry,
  open: async () => {},
  openCurrent: async () => {},
};

test('clone renders a page with navigation and the complete prepared catalog without a modal', () => {
  const html = renderToStaticMarkup(<CloneWorkspacePage api={api} currentPath={entry.rootPath} onClose={() => {}}
    initialCatalog={{ login: 'owner', repositories: [
      { id: 1, fullName: 'owner/project', description: null, private: true, cloneUrl: 'https://github.com/owner/project.git' },
    ] }} />);
  expect(html).toContain('<h1>Clone repository</h1>');
  expect(html).toContain('<main');
  expect(html).toContain('Back to Workspaces');
  expect(html).toContain('Select owner/project');
  expect(html).toContain('Clone and open');
  expect(html).not.toContain('role="dialog"');
  expect(html).not.toContain('aria-modal');
});

test('catalog preparation remains cancellable in the page before showing clone fields', () => {
  const html = renderToStaticMarkup(<PrepareCloneWorkspacePage api={api} currentPath={entry.rootPath} onClose={() => {}} />);
  expect(html).toContain('Back to Workspaces');
  expect(html).toContain('Preparing...');
  expect(html).not.toContain('Folder name');
  expect(html).not.toContain('role="dialog"');
});

test('clone progress displays shared loading and the active phase while blocking duplicate actions', () => {
  for (const opening of [false, true]) {
    const html = renderToStaticMarkup(<CloneWorkspaceProgress opening={opening} onBack={() => {}} />);
    expect(html).toContain(opening ? 'Repository cloned. Opening workspace…' : 'Cloning repository…');
    expect(html).toContain(opening ? 'Preparing...' : 'Processing...');
    expect(html).toContain('0.0s');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Clone and open');
    const navigation = (html.match(/<button\b[^>]*>/g) ?? [])
      .filter((button) => /aria-label="(?:Back to Workspaces|Close Workspaces)"/.test(button));
    expect(navigation).toHaveLength(2);
    for (const button of navigation) expect(button).toContain('disabled=""');
  }
});

test('worktrees opens as a page with shared loading and back navigation before displaying its form', () => {
  const html = renderToStaticMarkup(<WorktreeWorkspacePage api={api} currentPath={entry.rootPath} onClose={() => {}} />);
  expect(html).toContain('<h1>Git worktrees</h1>');
  expect(html).toContain('Back to Workspaces');
  expect(html).toContain('Preparing...');
  expect(html).not.toContain('role="dialog"');
  expect(html).not.toContain('Cancel');
  expect(html).not.toContain('New branch');
});

test('manual URL entry works as a page when the repository catalog is unavailable', () => {
  const html = renderToStaticMarkup(<CloneWorkspacePage api={api} currentPath={entry.rootPath} onClose={() => {}}
    initialCatalog={null} initialSource="url" />);
  expect(html).toContain('https://github.com/owner/project.git');
  expect(html).toContain('Uses your local Git credentials.');
  expect(html).not.toContain('Preparing...');
});

test('the page header blocks back and close while a workspace operation is pending', () => {
  for (const busy of [false, true]) {
    const html = renderToStaticMarkup(<WorkspaceManagerHeader title="Clone repository" icon={<GitFork />}
      busy={busy} onBack={() => {}} />);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    const navigation = buttons.filter((button) => /aria-label="(?:Back to Workspaces|Close Workspaces)"/.test(button));
    expect(navigation).toHaveLength(2);
    for (const button of navigation) expect(button.includes('disabled=""')).toBe(busy);
  }
});
