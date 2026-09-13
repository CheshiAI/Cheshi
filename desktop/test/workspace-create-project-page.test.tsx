import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { WorkspaceManagementApi } from '../shared/workspace-management';
import {
  CreateProjectProgress, CreateProjectWorkspacePage,
} from '../frontend/src/features/navigation/workspace-management/CreateProjectWorkspacePage';
import { createGitHubLoginApi } from './github-login-fixture';

const entry = { id: 'project', name: 'project', rootPath: '/work/project', available: true, isGitRepository: true };
const api: WorkspaceManagementApi = {
  ...createGitHubLoginApi(),
  getCodexLogin: async () => ({ state: 'signed_in', error: null }),
  startCodexLogin: async () => ({ state: 'signing_in', error: null }),
  cancelCodexLogin: async () => ({ state: 'signed_out', error: null }),
  getToolStatus: async () => ({ platform: 'darwin', brew: true, gh: true, codex: true }),
  openManager: async () => {},
  list: async () => ({ workspaces: [] }),
  chooseDirectory: async () => null,
  addFolder: async () => entry,
  deleteWorkspace: async () => false,
  createProject: async () => entry,
  clone: async () => entry,
  listGitHubRepositories: async () => ({ login: 'owner', repositories: [], nextPage: null }),
  listWorktrees: async () => [],
  createWorktree: async () => entry,
  open: async () => {},
  openCurrent: async () => {},
};

test('new project shows parent selection and a required name before enabling creation', () => {
  const html = renderToStaticMarkup(<CreateProjectWorkspacePage api={api} currentPath={entry.rootPath} onClose={() => {}} />);
  expect(html).toContain('<h1>Create project</h1>');
  expect(html).toContain('Back to Workspaces');
  expect(html).toContain('Choose project parent folder');
  expect(html).toContain('value="/work"');
  expect(html).toContain('Project name');
  expect(html).toContain('Create a new project folder with a local Git repository.');
  const submit = (html.match(/<button\b[^>]*>/g) ?? []).find((button) => button.includes('type="submit"'));
  expect(submit).toContain('disabled=""');
  expect(html.match(/required=""/g)).toHaveLength(2);
  expect(html).not.toContain('<dialog');
});

test('a first project with no current workspace requires the user to choose a parent', () => {
  const html = renderToStaticMarkup(<CreateProjectWorkspacePage api={api} currentPath="" onClose={() => {}} />);
  expect(html).toContain('Choose a parent folder and enter a project name.');
  expect(html.match(/value=""/g)).toHaveLength(2);
});

test('creation and opening progress block navigation and duplicate form submission', () => {
  for (const opening of [false, true]) {
    const html = renderToStaticMarkup(<CreateProjectProgress opening={opening} onBack={() => {}} />);
    expect(html).toContain(opening ? 'Project created. Opening workspace…' : 'Creating project and initializing Git…');
    expect(html).not.toContain('<form');
    const navigation = (html.match(/<button\b[^>]*>/g) ?? [])
      .filter((button) => /aria-label="(?:Back to Workspaces|Close Workspaces)"/.test(button));
    expect(navigation).toHaveLength(2);
    for (const button of navigation) expect(button).toContain('disabled=""');
  }
});
