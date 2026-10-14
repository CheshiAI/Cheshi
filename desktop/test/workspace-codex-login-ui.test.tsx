import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { WorkspaceCodexLoginActions, WorkspaceCodexLoginView } from '../frontend/src/features/navigation/workspace-management/WorkspaceCodexLogin';
import { WorkspaceManager } from '../frontend/src/features/navigation/workspace-management/WorkspaceManager';
import type { WorkspaceCodexLoginState, WorkspaceManagementApi } from '../shared/workspace-management';
import { withDOM } from './agent-chats-test-dom';
import { createGitHubLoginApi } from './github-login-fixture';

function render(state: WorkspaceCodexLoginState['state'], busy = false, ready = false) {
  const status = { state, error: state === 'error' ? 'Could not start Codex login.' : null };
  return renderToStaticMarkup(<>
    <WorkspaceCodexLoginView status={status} ready={ready} />
    <WorkspaceCodexLoginActions status={status} busy={busy} onLogin={() => {}} onCancel={() => {}} onRetry={() => {}} />
  </>);
}

test('Codex login is offered only when signed out and disappears when authenticated', () => {
  expect(render('signed_out')).toContain('Continue with ChatGPT');
  expect(render('signed_out', true)).toContain('disabled=""');
  expect(render('signed_out')).toContain('Welcome to Cheshi');
  expect(render('signed_in')).toContain('Preparing...');
  expect(render('signed_in', false, true)).toBe('');
  expect(render('checking')).toContain('Checking Codex sign-in');
  expect(render('checking')).not.toContain('<button');
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test('manager footer owns login, cancel and retry actions and clears them after authentication', async () => {
  await withDOM(async ui => {
    const previousEvent = globalThis.Event;
    globalThis.Event = window.Event;
    try {
      const login = createDeferred<WorkspaceCodexLoginState>();
      let loginState: WorkspaceCodexLoginState = { state: 'signed_out', error: null };
      let starts = 0, cancellations = 0;
      const api: WorkspaceManagementApi = {
        ...createGitHubLoginApi(),
        getCodexLogin: async () => loginState,
        startCodexLogin: async () => {
          starts++;
          if (starts === 1) loginState = await login.promise;
          else if (starts === 2) throw new Error('Sign-in failed');
          else loginState = { state: 'signed_in', error: null };
          return loginState;
        },
        cancelCodexLogin: async () => { cancellations++; loginState = { state: 'signed_out', error: null }; return loginState; },
        getToolStatus: async () => ({ platform: 'win32', brew: true, gh: true, codex: true }),
        list: async () => ({ workspaces: [] }), chooseDirectory: async () => null,
        deleteWorkspace: async () => false,
    removeWorkspace: async () => false,
        listGitHubRepositories: async () => ({ login: 'test', repositories: [], nextPage: null }),
        addFolder: async () => { throw new Error('Unexpected add'); },
        createProject: async () => { throw new Error('Unexpected create'); },
        clone: async () => { throw new Error('Unexpected clone'); },
        listWorktrees: async () => [], createWorktree: async () => { throw new Error('Unexpected worktree'); },
        open: async () => {}, openCurrent: async () => {}, openManager: async () => {},
      };
      await ui.render(<WorkspaceManager api={api} workspaceName="Workspaces" workspaceRoot="" platform="win32" />);
      const footerButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('footer button'))
        .find(button => button.textContent === label);
      expect(document.querySelector('h1')?.textContent).toBe('WORKSPACES');
      expect(document.querySelector('main')?.textContent).toContain('Welcome to Cheshi');
      expect(document.querySelector('main button')).toBeNull();
      expect(footerButton('Continue with ChatGPT')).toBeDefined();
      await ui.click('Continue with ChatGPT');
      expect(footerButton('Continue with ChatGPT')?.disabled).toBe(true);
      await ui.click('Continue with ChatGPT');
      expect(starts).toBe(1);
      await act(async () => { login.resolve({ state: 'signing_in', error: null }); });
      expect(footerButton('Cancel')).toBeDefined();
      expect(document.querySelector('main button')).toBeNull();
      await ui.click('Cancel');
      expect(cancellations).toBe(1);
      expect(footerButton('Continue with ChatGPT')).toBeDefined();
      await ui.click('Continue with ChatGPT');
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('sign-in is unavailable');
      expect(footerButton('Retry')).toBeDefined();
      await ui.click('Retry');
      expect(starts).toBe(3);
      expect(footerButton('Retry')).toBeUndefined();
      expect(footerButton('Continue with ChatGPT')).toBeUndefined();
      expect(footerButton('Create project')).toBeDefined();
      expect(document.querySelector('main')?.textContent).not.toContain('Welcome to Cheshi');
    } finally { globalThis.Event = previousEvent; }
  });
});

test('waiting sign-in can be cancelled and failures offer retry without displaying auth details', () => {
  const waiting = render('signing_in');
  expect(waiting).toContain('Complete sign-in in your browser');
  expect(waiting).toContain('Cancel');
  expect(waiting).not.toContain('Continue with ChatGPT');
  const error = render('error');
  expect(error).toContain('role="alert"');
  expect(error).toContain('Retry');
  expect(error).not.toContain('authUrl');
});
