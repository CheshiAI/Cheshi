import { expect, test } from 'bun:test';
import { listGitHubIssues, readGitHubIssue, readGitHubIssueComments, gitHubIssueUrl } from '../lib/github-issue-service.mts';
import { createGitHubIssuesApi } from '../lib/github-issue-preload.cts';
import { parseIssueQuery, parseIssueNumber, parseIssuePage } from '../shared/github-issues';
import type { CommandResult } from '../lib/git-types.mts';
import { registerGitIpcHandlers } from '../lib/git-ipc.mts';
import type { GitService } from '../lib/git-service.mts';
import type { IpcMainInvokeEvent } from 'electron';

const repo = { nameWithOwner: 'owner/project', url: 'https://github.com/owner/project' };
const issue = {
  number: 9, title: 'Restore files', state: 'open', user: { login: 'author' },
  updated_at: '2026-09-15T12:00:00Z', labels: [{ name: 'feature' }], assignees: [{ login: 'assignee' }],
  html_url: 'https://github.com/owner/project/issues/9', body: 'Description', comments: 1,
};
function context(responses: unknown[]) {
  const calls: string[][] = [];
  return { calls, async runGitHub(args: string[]): Promise<CommandResult> {
    calls.push(args);
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return { stdout: JSON.stringify(result), stderr: '', exitCode: 0, truncated: false };
  } };
}
async function fails(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

test('issue list stays scoped to the workspace and sends literal search through GET arguments', async () => {
  const service = context([repo, { total_count: 26, incomplete_results: false, items: [issue] },
    { total_count: 4, incomplete_results: false }]);
  const result = await listGitHubIssues(service, { search: 'file repo:other/project', state: 'open', page: 1 });
  expect(result).toMatchObject({ repository: 'owner/project', total: 26, hasMore: true, incomplete: false, counts: { open: 26, closed: 4, all: 30 } });
  expect(result.issues[0]).toMatchObject({ number: 9, labels: ['feature'], assignees: ['assignee'], author: 'author' });
  expect(service.calls[1]).toEqual(['api', '--hostname', 'github.com', '--method', 'GET', 'search/issues',
    '-f', 'q=repo:owner/project is:issue is:open "file repo:other/project" in:title,body',
    '-f', 'sort=updated', '-f', 'order=desc', '-f', 'per_page=25', '-f', 'page=1']);
});

test('closed and all states, empty results and search result caps are represented accurately', async () => {
  for (const state of ['closed', 'all'] as const) {
    const service = context([repo, { total_count: 0, incomplete_results: false, items: [] },
      { total_count: 0, incomplete_results: false }, { total_count: 0, incomplete_results: false }]);
    expect((await listGitHubIssues(service, { search: '', state, page: 1 })).hasMore).toBe(false);
    expect(service.calls[1]?.join(' ')).toContain(state === 'closed' ? 'is:closed' : 'q=repo:owner/project is:issue -f');
  }
  const capped = context([repo, { total_count: 1001, incomplete_results: false, items: [] }]);
  expect(await listGitHubIssues(capped, { search: '', state: 'all', page: 40 })).toMatchObject({ incomplete: true, hasMore: false });
});

test('invalid requests fail before launching gh', async () => {
  for (const page of [0, 41, 1.5, '1']) expect(() => parseIssuePage(page)).toThrow();
  for (const number of [0, -1, '9', NaN]) expect(() => parseIssueNumber(number)).toThrow();
  for (const state of [true, {}, 'merged']) expect(() => parseIssueQuery({ state, search: '', page: 1 })).toThrow();
  const service = context([]);
  await fails(listGitHubIssues(service, { state: 'open', search: 'x'.repeat(201), page: 1 }), 'Invalid');
  expect(service.calls).toHaveLength(0);
});

test('rejects pull requests, cross-repository responses and malformed GitHub data', async () => {
  for (const invalid of [{ ...issue, pull_request: {} }, { ...issue, html_url: 'https://github.com/elsewhere/repo/issues/9' }, { ...issue, labels: null }]) {
    await fails(listGitHubIssues(context([repo, { total_count: 1, incomplete_results: false, items: [invalid] }]),
      { search: '', state: 'open', page: 1 }), 'GitHub returned');
  }
  await fails(readGitHubIssue(context([repo, issue]), 10), 'different issue');
  await fails(gitHubIssueUrl(context([{ ...repo, url: 'https://evil.test' }]), 9), 'GitHub.com');
});

test('auth and command failures remain visible; truncated responses are not parsed', async () => {
  await fails(listGitHubIssues(context([new Error('Please run gh auth login')]), { search: '', state: 'open', page: 1 }), 'gh auth login');
  await fails(readGitHubIssue({ runGitHub: async () => ({ stdout: '{}', stderr: '', exitCode: 0, truncated: true }) }, 9), 'too large');
});

test('details handle missing bodies and deleted authors; comments load a bounded page', async () => {
  expect(await readGitHubIssue(context([repo, { ...issue, body: null, user: null }]), 9))
    .toMatchObject({ body: '', author: 'ghost', commentCount: 1 });
  const comments = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, user: null, body: 'Comment', created_at: '2026-09-15T12:00:00Z' }));
  const service = context([repo, comments]);
  expect(await readGitHubIssueComments(service, 9, 2)).toMatchObject({ hasMore: true });
  expect(service.calls[1]).toContain('repos/owner/project/issues/9/comments');
  expect(service.calls[1]).toContain('page=2');
  expect((await readGitHubIssueComments(context([repo, []]), 9, 3)).hasMore).toBe(false);
  expect(await gitHubIssueUrl(context([repo]), 9)).toBe('https://github.com/owner/project/issues/9');
});

test('preload exposes only the four read-only issue operations and validates request values', async () => {
  const calls: unknown[][] = [];
  const api = createGitHubIssuesApi({ invoke: async (...args: unknown[]) => { calls.push(args); return {}; } });
  await api.list({ search: '', state: 'open', page: 1 }); await api.read(9); await api.comments(9, 2); await api.open(9);
  expect(calls.map(call => call[0])).toEqual(['cheshi:list-github-issues', 'cheshi:read-github-issue', 'cheshi:read-github-issue-comments', 'cheshi:open-github-issue']);
  expect(() => api.read(-1)).toThrow();
});

test('IPC verifies the sender before accessing GitHub or opening an external URL', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const service = context([repo]);
  let allowed = false;
  const opened: string[] = [];
  registerGitIpcHandlers({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    gitService: service as unknown as GitService,
    assertCheshiSender: () => { if (!allowed) throw new Error('Invalid sender'); },
    shell: { openExternal: async url => { opened.push(url); }, trashItem: async () => {} },
  });
  const event = {} as IpcMainInvokeEvent;
  for (const channel of ['cheshi:list-github-issues', 'cheshi:read-github-issue', 'cheshi:read-github-issue-comments']) {
    expect(() => handlers.get(channel)!(event, 9)).toThrow('Invalid sender');
  }
  await fails(Promise.resolve(handlers.get('cheshi:open-github-issue')!(event, 9)), 'Invalid sender');
  expect(service.calls).toHaveLength(0); expect(opened).toEqual([]);
  allowed = true;
  await handlers.get('cheshi:open-github-issue')!(event, 9);
  expect(opened).toEqual(['https://github.com/owner/project/issues/9']);
});

test('counts use the same search across states and do not count only loaded rows', async () => {
  const service = context([repo, { total_count: 250, incomplete_results: false, items: [issue] },
    { total_count: 75, incomplete_results: false }, { total_count: 175, incomplete_results: false }]);
  const result = await listGitHubIssues(service, { search: '파일', state: 'all', page: 1 });
  expect(result.counts).toEqual({ open: 75, closed: 175, all: 250 });
  expect(result.issues).toHaveLength(1);
  for (const [index, state] of ['open', 'closed'].entries()) {
    expect(service.calls[index + 2]).toContain(`q=repo:owner/project is:issue is:${state} "파일" in:title,body`);
    expect(service.calls[index + 2]).toContain('per_page=1');
  }
});

test('subsequent pages do not repeat count queries and incomplete counts stay unknown', async () => {
  const service = context([repo, { total_count: 30, incomplete_results: false, items: [issue] }]);
  expect((await listGitHubIssues(service, { search: '', state: 'open', page: 2 })).counts).toBeNull();
  expect(service.calls).toHaveLength(2);
  const incomplete = context([repo, { total_count: 1, incomplete_results: false, items: [issue] },
    { total_count: 0, incomplete_results: true }]);
  expect(await listGitHubIssues(incomplete, { search: '', state: 'open', page: 1 }))
    .toMatchObject({ counts: null, incomplete: true });
});

test('count failures and invalid counts do not produce misleading zero badges', async () => {
  for (const response of [new Error('Count rate limited'), { total_count: -1, incomplete_results: false }]) {
    const service = context([repo, { total_count: 1, incomplete_results: false, items: [issue] }, response]);
    await fails(listGitHubIssues(service, { search: '', state: 'open', page: 1 }),
      response instanceof Error ? 'Count rate limited' : 'invalid count');
  }
});
