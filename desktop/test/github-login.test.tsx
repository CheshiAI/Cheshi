import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createGitHubLoginApi } from './github-login-fixture';
import { runGitHubLogin } from '../frontend/src/features/navigation/workspace-management/github-login';
import { GitHubSignIn } from '../frontend/src/features/navigation/workspace-management/GitHubSignIn';
import { workspaceError } from '../frontend/src/features/navigation/workspace-management/workspace-paths';
import type { GitHubLoginState } from '../shared/workspace-management';

const starting: GitHubLoginState = { state: 'starting', userCode: null, error: null };
const waiting: GitHubLoginState = { state: 'waiting', userCode: 'TEST-CODE', error: null };
const complete: GitHubLoginState = { state: 'complete', userCode: null, error: null };
const signInMessage = 'Sign in to GitHub CLI with gh auth login --hostname github.com, then retry.';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('logged out errors show browser sign in and manual URL without Electron internals', () => {
  const error = workspaceError(new Error(`Error invoking remote method 'cheshi:workspace-management:list-github-repositories': Error: ${signInMessage}`));
  const html = renderToStaticMarkup(<GitHubSignIn api={createGitHubLoginApi()} error={error} onRetry={() => {}} onManual={() => {}} />);
  expect(html).toContain('Sign in with GitHub');
  expect(html).toContain('Enter repository URL');
  expect(html).not.toContain('remote method');
  expect(html).not.toContain('gh auth login');
});

test('network and permission errors keep retry without presenting login as their solution', () => {
  const html = renderToStaticMarkup(<GitHubSignIn api={createGitHubLoginApi()} error="GitHub denied this request." onRetry={() => {}} />);
  expect(html).toContain('GitHub denied this request.');
  expect(html).toContain('Retry');
  expect(html).not.toContain('Sign in with GitHub');
  expect(workspaceError(new Error('Other failure: Error: keep detail'))).toBe('Other failure: Error: keep detail');
});

test('sign in opens the browser once after code arrival and completes automatically', async () => {
  const states: string[] = [];
  const replies = [waiting, waiting, complete];
  let opened = 0;
  let canceled = 0;
  const api = createGitHubLoginApi({
    startGitHubLogin: async () => starting,
    getGitHubLogin: async () => replies.shift()!,
    openGitHubLoginBrowser: async () => { opened += 1; },
    cancelGitHubLogin: async () => { canceled += 1; },
  });
  const done = await runGitHubLogin({ api, signal: new AbortController().signal,
    onState: (state) => states.push(state.state), onBrowserError: () => { throw new Error('Unexpected browser error'); }, wait: async () => {},
  });
  expect(done).toBe(true);
  expect(states).toEqual(['starting', 'waiting', 'waiting', 'complete']);
  expect(opened).toBe(1);
  expect(canceled).toBe(0);
});

test('browser launch failure keeps polling so manual browser completion still works', async () => {
  const errors: unknown[] = [];
  const api = createGitHubLoginApi({ startGitHubLogin: async () => waiting, getGitHubLogin: async () => complete,
    openGitHubLoginBrowser: async () => { throw new Error('Browser unavailable'); },
  });
  expect(await runGitHubLogin({ api, signal: new AbortController().signal, onState() {},
    onBrowserError: (error) => errors.push(error), wait: async () => {},
  })).toBe(true);
  expect(errors).toHaveLength(1);
});

test('leaving the page cancels once and discards a late start response', async () => {
  const response = createDeferred<GitHubLoginState>();
  const controller = new AbortController();
  let canceled = 0;
  const states: GitHubLoginState[] = [];
  const api = createGitHubLoginApi({ startGitHubLogin: () => response.promise, cancelGitHubLogin: async () => { canceled += 1; } });
  const pending = runGitHubLogin({ api, signal: controller.signal, onState: (state) => states.push(state), onBrowserError() {} });
  controller.abort();
  expect(canceled).toBe(1);
  response.resolve(waiting);
  expect(await pending).toBe(false);
  expect(states).toEqual([]);
  expect(canceled).toBe(1);
});

test('failed or expired authentication never reports completion', async () => {
  const states: GitHubLoginState[] = [];
  const failed: GitHubLoginState = { state: 'error', userCode: null, error: 'GitHub sign-in expired.' };
  const api = createGitHubLoginApi({ startGitHubLogin: async () => failed });
  expect(await runGitHubLogin({ api, signal: new AbortController().signal, onState: (state) => states.push(state), onBrowserError() {} })).toBe(false);
  expect(states).toEqual([failed]);
});
