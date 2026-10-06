import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as react from 'react';
import { act } from 'react';
import * as reactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import type { CheshiDesktopApi, GitDiffRequest, GitRepositorySnapshot } from '../frontend/src/cheshiDesktop';
import type { GitWorkspace } from '../frontend/src/features/git/GitWorkspace';
import type { GitHubIssueDetail, GitHubIssueList, GitHubIssueQuery } from '../shared/github-issues';
import { withDOM } from './agent-chats-test-dom';

async function workspaceWithApi(api: Partial<CheshiDesktopApi>) {
  // Inject the native bridge; exercise the real controller, views and portal without touching Git.
  const modules: Record<string, unknown> = {
    react, 'react-dom': reactDOM, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
    '../../cheshiDesktop': { cheshiDesktop: api },
    '../../shared/ui': await import('../frontend/src/shared/ui'),
    '../../shared/errorMessage': await import('../frontend/src/shared/errorMessage'),
    './gitBranchCheckout': await import('../frontend/src/features/git/gitBranchCheckout'),
    './gitRepositoryRefresh': await import('../frontend/src/features/git/gitRepositoryRefresh'),
    './useGitBranchHistory': await import('../frontend/src/features/git/useGitBranchHistory'),
    './useGitPullRequestCommitDiff': await import('../frontend/src/features/git/useGitPullRequestCommitDiff'),
    './gitWorkspaceModel': await import('../frontend/src/features/git/gitWorkspaceModel'),
    './unifiedDiff': await import('../frontend/src/features/git/unifiedDiff'),
    './GitWorkspaceHeader': await import('../frontend/src/features/git/GitWorkspaceHeader'),
    './GitChangesWorkspace': await import('../frontend/src/features/git/GitChangesWorkspace'),
    './GitHistoryWorkspace': await import('../frontend/src/features/git/GitHistoryWorkspace'),
    './useGitIssues': await import('../frontend/src/features/git/useGitIssues'),
    '../../shared/ui/Badge.module.css': { default: {} },
    './GitIssuesWorkspace.module.css': { default: {} },
    './GitPullRequestsWorkspace': await import('../frontend/src/features/git/GitPullRequestsWorkspace'),
    './GitWorkspace.module.css': { default: {} },
  };
  function load(filename: string) {
    const source = readFileSync(new URL(`../frontend/src/features/git/${filename}`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
    } });
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(compiled.outputText, { exports, window, document, performance, setTimeout,
      require(name: string) {
        if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected Git dependency: ${name}`);
        return modules[name];
      },
    });
    return exports;
  }
  modules['./useGitWorkspaceController'] = load('useGitWorkspaceController.ts');
  modules['./GitIssuesWorkspace'] = load('GitIssuesWorkspace.tsx');
  return load('GitWorkspace.tsx').GitWorkspace as typeof GitWorkspace;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function issueFixture() {
  const scenario = fixture();
  const requests: GitHubIssueQuery[] = [];
  const details: number[] = [];
  const comments: number[] = [];
  const issue: GitHubIssueDetail = { number: 18, title: 'Cached issue', state: 'closed', author: 'author',
    updatedAt: '2026-10-07', labels: [], assignees: [], body: 'Saved issue description', commentCount: 1 };
  const result: GitHubIssueList = { repository: 'owner/repo', issues: [issue], total: 1, hasMore: false,
    incomplete: false, counts: { open: 0, closed: 1, all: 1 } };
  scenario.api.githubIssues = {
    list: async query => { requests.push(query); return result; },
    read: async number => { details.push(number); return issue; },
    comments: async number => {
      comments.push(number);
      return { comments: [{ id: 1, author: 'author', body: 'Saved comment', createdAt: '2026-10-07' }], hasMore: false };
    },
    open: async () => {},
  };
  return { ...scenario, requests, details, comments, result };
}

function fixture() {
  let snapshot: GitRepositorySnapshot = { available: true, message: '', changes: ['alpha.ts', 'beta.ts'].map(path => ({
    path, oldPath: null, indexStatus: ' ', workingTreeStatus: 'M', staged: false, unstaged: true, untracked: false,
  })) };
  let reads = 0;
  const diffs: GitDiffRequest[] = [], stages: string[][] = [], unstages: string[][] = [], commits: string[] = [];
  const commitGate = createDeferred<void>();
  const stage = (paths: string[], staged: boolean) => {
    snapshot = { ...snapshot, changes: snapshot.changes?.map(change => paths.includes(change.path)
      ? { ...change, staged, unstaged: !staged, indexStatus: staged ? 'M' : ' ', workingTreeStatus: staged ? ' ' : 'M' }
      : change) };
    return snapshot;
  };
  const api: Partial<CheshiDesktopApi> = {
    getGitSnapshot: async () => { reads++; return snapshot; },
    getGitDiff: async request => {
      diffs.push(request);
      const path = request.path ?? 'alpha.ts';
      return { ...request, path, commit: null, binary: false, truncated: false,
        patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+updated ${path}\n` };
    },
    stageGitPaths: async paths => { stages.push(paths); return stage(paths, true); },
    unstageGitPaths: async paths => { unstages.push(paths); return stage(paths, false); },
    commitGitChanges: async message => {
      commits.push(message);
      await commitGate.promise;
      snapshot = { ...snapshot, changes: snapshot.changes?.filter(change => !change.staged) };
      return { output: '', snapshot };
    },
  };
  return { api, reads: () => reads, diffs, stages, unstages, commits, commitGate };
}

async function settleLoading() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 420)); });
}

function row(sidebar: HTMLElement, path: string) {
  const button = [...sidebar.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
    .find(element => element.textContent?.endsWith(path));
  if (!button) throw new Error(`Missing change row: ${path}`);
  return button;
}

async function toggleFile(label: string) {
  const input = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .find(element => element.getAttribute('aria-label') === label);
  if (!input) throw new Error(`Missing file checkbox: ${label}`);
  await act(async () => input.click());
}

test('Git preloads before its first visit, retains draft and selection in a late sidebar portal, and opens the selected diff', async () => {
  await withDOM(async ui => {
    const scenario = fixture();
    const View = await workspaceWithApi(scenario.api);
    const sidebar = document.createElement('aside');
    document.body.append(sidebar);
    let opened = 0;
    const render = (active: boolean, sidebarTarget: HTMLElement | null = sidebar) =>
      ui.render(<View active={active} sidebarTarget={sidebarTarget}
        onOpenChanges={() => { opened++; }} onOpenWorkspaceFile={() => {}}
        rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await render(false, null);
    expect(scenario.reads()).toBe(1);
    expect(document.querySelector('main')?.hidden).toBe(true);
    await settleLoading();
    expect(document.querySelector('[aria-label="Git changes"]')).toBeNull();
    await render(true);
    expect(sidebar.querySelector('[aria-label="Git changes"]')).not.toBeNull();
    expect(document.querySelector('main [aria-label="Git changes"]')).toBeNull();
    expect(sidebar.querySelector('[aria-label="Commit message"]')).not.toBeNull();
    await act(async () => row(sidebar, 'beta.ts').click());
    expect(opened).toBe(1);
    expect(scenario.diffs.at(-1)).toEqual({ scope: 'working', path: 'beta.ts' });
    expect(document.querySelector('main')?.textContent).toContain('updated beta.ts');
    await toggleFile('Stage beta.ts');
    expect(row(sidebar, 'beta.ts').getAttribute('aria-pressed')).toBe('true');
    await ui.type('Commit message', 'Keep this commit draft');
    const input = sidebar.querySelector<HTMLInputElement>('[aria-label="Commit message"]')!;
    const selected = row(sidebar, 'beta.ts');
    await render(false);
    expect(document.querySelector('main')?.hidden).toBe(true);
    await render(true);
    expect(sidebar.querySelector('[aria-label="Commit message"]')).toBe(input);
    expect(input.value).toBe('Keep this commit draft');
    expect(row(sidebar, 'beta.ts')).toBe(selected);
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(scenario.reads()).toBe(1);

    await ui.click('Branches & Log');
    expect(sidebar.querySelector('[aria-label="Commit message"]')).toBe(input);
    await act(async () => row(sidebar, 'beta.ts').click());
    expect(scenario.diffs.at(-1)).toEqual({ scope: 'staged', path: 'beta.ts' });
    expect(document.querySelector('[aria-label="Git sections"] [aria-current="page"]')?.textContent).toContain('Changes');
    expect(input.value).toBe('Keep this commit draft');
    expect(opened).toBe(2);
  });
});

test('portaled Git controls retain multi-selection, stage and unstage, and block duplicate commits', async () => {
  await withDOM(async ui => {
    const scenario = fixture();
    const View = await workspaceWithApi(scenario.api);
    const sidebar = document.createElement('aside');
    document.body.append(sidebar);
    await ui.render(<View sidebarTarget={sidebar} onOpenWorkspaceFile={() => {}}
      rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await settleLoading();
    await act(async () => row(sidebar, 'alpha.ts').click());
    await act(async () => row(sidebar, 'beta.ts').dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(sidebar.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(2);
    await ui.click('Stage all changes');
    expect(scenario.stages).toEqual([['alpha.ts', 'beta.ts']]);
    expect(sidebar.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(2);
    expect(sidebar.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(2);
    await toggleFile('Unstage beta.ts');
    expect(scenario.unstages).toEqual([['beta.ts']]);
    expect(sidebar.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(1);
    expect(sidebar.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(2);
    await ui.type('Commit message', '[fix] update alpha');
    await ui.click('Commit');
    await ui.click('Commit');
    expect(scenario.commits).toEqual(['[fix] update alpha']);
    expect(sidebar.querySelector<HTMLInputElement>('[aria-label="Commit message"]')?.disabled).toBe(true);
    expect(sidebar.querySelector<HTMLButtonElement>('[aria-label="Discard changes in beta.ts"]')?.disabled).toBe(true);
    await act(async () => scenario.commitGate.resolve());
    expect(sidebar.querySelector<HTMLInputElement>('[aria-label="Commit message"]')?.value).toBe('');
    expect(sidebar.textContent).not.toContain('alpha.ts');
    expect(sidebar.textContent).toContain('beta.ts');
  });
});

test('Git sidebar retains its header and controls from initial loading through unavailable states', async () => {
  await withDOM(async ui => {
    const gate = createDeferred<GitRepositorySnapshot>();
    const View = await workspaceWithApi({ getGitSnapshot: () => gate.promise });
    const sidebar = document.createElement('aside');
    document.body.append(sidebar);
    const render = (target: HTMLElement | null) => ui.render(<View active={false} sidebarTarget={target}
      onOpenWorkspaceFile={() => {}} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await render(null);
    await render(sidebar);
    expect(sidebar.querySelector('[role="status"]')).not.toBeNull();
    expect(document.querySelector('main')?.hidden).toBe(true);
    const header = sidebar.querySelector('header');
    expect(header).not.toBeNull();
    const input = sidebar.querySelector<HTMLInputElement>('[aria-label="Commit message"]')!;
    expect(input.disabled).toBe(true);
    expect(sidebar.textContent).not.toContain('No unstaged changes');
    await act(async () => gate.resolve({ available: false, message: 'Not a repository' }));
    await settleLoading();
    expect(sidebar.textContent).toContain('Not a repository');
    expect(sidebar.querySelector('header')).toBe(header);
    expect(sidebar.querySelector('[aria-label="Commit message"]')).toBe(input);
    expect(input.disabled).toBe(true);
  });
});

test('Git initial loading keeps the panel shell when data arrives without a visit', async () => {
  await withDOM(async ui => {
    const gate = createDeferred<GitRepositorySnapshot>();
    let reads = 0;
    const View = await workspaceWithApi({ getGitSnapshot: () => { reads++; return gate.promise; } });
    const sidebar = document.createElement('aside');
    document.body.append(sidebar);
    await ui.render(<View active={false} sidebarTarget={sidebar} onOpenWorkspaceFile={() => {}}
      rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    const header = sidebar.querySelector('header');
    expect(header).not.toBeNull();
    const input = sidebar.querySelector('[aria-label="Commit message"]');
    expect(reads).toBe(1);
    expect(sidebar.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => gate.resolve({ available: true, message: '', changes: [] }));
    await settleLoading();
    expect(sidebar.querySelector('header')).toBe(header);
    expect(sidebar.querySelector('[aria-label="Commit message"]')).toBe(input);
    expect(sidebar.querySelector('[role="status"]')).toBeNull();
    expect(sidebar.textContent).toContain('No unstaged changes');
    expect(document.querySelector('main')?.hidden).toBe(true);
  });
});

test('Issues retains search, filters, selection and cached details across tabs until explicit refresh', async () => {
  await withDOM(async ui => {
    const scenario = issueFixture();
    const View = await workspaceWithApi(scenario.api);
    const render = (active = true) => ui.render(<View active={active} onOpenWorkspaceFile={() => {}}
      rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await render();
    await settleLoading();
    expect(scenario.requests).toHaveLength(0);
    expect(document.querySelector('[aria-label="GitHub issues"]')).toBeNull();
    await ui.click('Issues');
    expect(scenario.requests).toEqual([{ search: '', state: 'open', page: 1 }]);
    const panel = document.querySelector<HTMLElement>('[aria-label="GitHub issues"]')!;
    const closedFilter = [...panel.querySelectorAll<HTMLButtonElement>('[aria-label="Issue state"] button')]
      .find(button => button.textContent?.startsWith('Closed'))!;
    await act(async () => closedFilter.click());
    await ui.type('Search issue titles and bodies', 'cache');
    const input = panel.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => input.form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(scenario.requests.at(-1)).toEqual({ search: 'cache', state: 'closed', page: 1 });
    const selectedRow = panel.querySelector<HTMLButtonElement>('[aria-label="Issue list"] button')!;
    await act(async () => selectedRow.click());
    expect(panel.textContent).toContain('Saved issue description');
    expect(panel.textContent).toContain('Saved comment');
    await ui.type('Search issue titles and bodies', 'unsubmitted draft');
    const list = panel.querySelector<HTMLElement>('[aria-label="Issue list"]')!;
    list.scrollTop = 80;
    const requestCount = scenario.requests.length;

    await ui.click('Branches & Log');
    expect(panel.hidden).toBe(true);
    await render(false);
    await render();
    await ui.click('Issues');
    expect(document.querySelector('[aria-label="GitHub issues"]')).toBe(panel);
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector('input[type="search"]')).toBe(input);
    expect(input.value).toBe('unsubmitted draft');
    expect(closedFilter.getAttribute('aria-pressed')).toBe('true');
    expect(selectedRow.getAttribute('aria-pressed')).toBe('true');
    expect(list.scrollTop).toBe(80);
    expect(panel.textContent).toContain('Saved issue description');
    expect(panel.textContent).toContain('Saved comment');
    expect(scenario.requests).toHaveLength(requestCount);
    expect(scenario.details).toEqual([18]);
    expect(scenario.comments).toEqual([18]);
    expect(panel.querySelector('[aria-busy="true"]')).toBeNull();

    await ui.click('Refresh Git');
    expect(scenario.requests).toHaveLength(requestCount + 1);
    expect(scenario.requests.at(-1)).toEqual({ search: 'cache', state: 'closed', page: 1 });
    const refreshedRow = panel.querySelector<HTMLButtonElement>('[aria-label="Issue list"] button')!;
    await act(async () => refreshedRow.click());
    expect(scenario.details).toEqual([18, 18]);
    expect(scenario.comments).toEqual([18, 18]);
  });
});

test('leaving Issues while its first request is pending keeps one request and retains the result', async () => {
  await withDOM(async ui => {
    const scenario = issueFixture();
    const gate = createDeferred<GitHubIssueList>();
    scenario.api.githubIssues!.list = query => { scenario.requests.push(query); return gate.promise; };
    const View = await workspaceWithApi(scenario.api);
    await ui.render(<View onOpenWorkspaceFile={() => {}} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await settleLoading();
    await ui.click('Issues');
    const panel = document.querySelector<HTMLElement>('[aria-label="GitHub issues"]')!;
    expect(panel.querySelector('[aria-label="Issue list"]')?.getAttribute('aria-busy')).toBe('true');
    await ui.click('Branches & Log');
    await ui.click('Issues');
    expect(scenario.requests).toHaveLength(1);
    await ui.click('Branches & Log');
    await act(async () => gate.resolve(scenario.result));
    expect(panel.hidden).toBe(true);
    await ui.click('Issues');
    expect(scenario.requests).toHaveLength(1);
    expect(panel.textContent).toContain('Cached issue');
    expect(panel.querySelector('[aria-label="Issue list"]')?.getAttribute('aria-busy')).toBe('false');
  });
});

test('range selection follows its anchor through staging and failed staging preserves selection', async () => {
  await withDOM(async ui => {
    const scenario = fixture();
    const stage = scenario.api.stageGitPaths!;
    let fail = true;
    scenario.api.stageGitPaths = async paths => {
      if (fail) throw new Error('Staging failed');
      return stage(paths);
    };
    const View = await workspaceWithApi(scenario.api);
    const sidebar = document.createElement('aside');
    document.body.append(sidebar);
    await ui.render(<View sidebarTarget={sidebar} onOpenWorkspaceFile={() => {}}
      rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await settleLoading();
    await act(async () => row(sidebar, 'beta.ts').click());
    await toggleFile('Stage beta.ts');
    expect(row(sidebar, 'beta.ts').getAttribute('aria-pressed')).toBe('true');
    expect(sidebar.querySelectorAll('input:checked')).toHaveLength(0);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Staging failed');
    fail = false;
    await ui.click('Stage all changes');
    expect(row(sidebar, 'beta.ts').getAttribute('aria-pressed')).toBe('true');
    await act(async () => row(sidebar, 'alpha.ts').dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(sidebar.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(2);
    await ui.click('Unstage all changes');
    expect(sidebar.querySelectorAll('input:checked')).toHaveLength(0);
    expect(sidebar.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(2);
  });
});
