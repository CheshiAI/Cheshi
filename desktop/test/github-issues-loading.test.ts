import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { useGitIssues } from '../frontend/src/features/git/useGitIssues';
import type { GitHubIssuesApi, GitHubIssueList, GitHubIssueDetail, GitHubIssueComments, GitHubIssueState } from '../shared/github-issues';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
interface Slot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
function harness(api: GitHubIssuesApi | undefined) {
  const slots: Slot[] = [];
  const effects: (() => void)[] = [];
  let cursor = 0;
  const slot = () => slots[cursor++] ??= {};
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) => a?.length === b.length && b.every((v, i) => Object.is(v, a[i]));
  const react = {
    useState(initial: unknown) { const s = slot(); if (!Object.hasOwn(s, 'value')) s.value = initial;
      return [s.value, (next: unknown) => { s.value = typeof next === 'function' ? next(s.value) : next; }]; },
    useRef(value: unknown) { const s = slot(); return s.value ??= { current: value }; },
    useCallback(value: unknown, deps: readonly unknown[]) { const s = slot(); if (!same(s.deps, deps)) { s.value = value; s.deps = deps; } return s.value; },
    useEffect(run: () => void | (() => void), deps: readonly unknown[]) { const s = slot(); if (same(s.deps, deps)) return;
      s.deps = deps; effects.push(() => { s.cleanup?.(); s.cleanup = run() ?? undefined; }); },
  };
  const exports: Record<string, unknown> = {};
  const source = readFileSync(new URL('../frontend/src/features/git/useGitIssues.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, {
    exports, require: (name: string) => {
      if (name === 'react') return react;
      if (name === '../../shared/errorMessage') return { errorMessage: (error: Error) => error.message };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const hook = exports.useGitIssues as typeof useGitIssues;
  return {
    render(search = '', state: GitHubIssueState = 'open', revision = 0) { cursor = 0; return hook(api, { search, state }, revision); },
    effects() { effects.splice(0).forEach(run => run()); },
    dispose() { slots.forEach(s => s.cleanup?.()); },
  };
}
const issue: GitHubIssueDetail = { number: 1, title: 'First', state: 'open', author: 'a', updatedAt: '2026-09-15', labels: [], assignees: [], body: 'First body', commentCount: 0 };
const list = (number: number): GitHubIssueList => ({ repository: 'a/b', issues: [{ ...issue, number }], total: 1, hasMore: false, incomplete: false, counts: { open: number, closed: 2, all: number + 2 } });
function api(overrides: Partial<GitHubIssuesApi> = {}): GitHubIssuesApi {
  return { list: async () => list(1), read: async number => ({ ...issue, number }),
    comments: async () => ({ comments: [], hasMore: false }), open: async () => {}, ...overrides };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

test('does not fetch before mounting effects; a changed search ignores previous results', async () => {
  const first = createDeferred<GitHubIssueList>(); const second = createDeferred<GitHubIssueList>();
  const searches: string[] = [];
  const h = harness(api({ list: query => { searches.push(query.search); return query.search ? second.promise : first.promise; } }));
  h.render(); expect(searches).toEqual([]); h.effects(); expect(searches).toEqual(['']);
  h.render('new'); h.effects(); second.resolve(list(2)); await settle();
  first.resolve(list(1)); await settle();
  expect(h.render('new').list?.issues.map(item => item.number)).toEqual([2]);
  expect(h.render('new').list?.counts).toEqual({ open: 2, closed: 2, all: 4 }); h.dispose();
});

test('previous detail and comments cannot replace a newly selected issue', async () => {
  const first = createDeferred<GitHubIssueDetail>(); const comments = createDeferred<GitHubIssueComments>();
  const h = harness(api({ read: number => number === 1 ? first.promise : Promise.resolve({ ...issue, number, commentCount: 1 }),
    comments: () => comments.promise }));
  h.render(); h.effects(); await settle();
  h.render().setSelected(1); h.render(); h.effects();
  h.render().setSelected(2); h.render(); h.effects(); await settle();
  first.resolve(issue); await settle(); expect(h.render().detail?.number).toBe(2);
  h.render().setSelected(3); h.render(); h.effects(); await settle();
  h.render().setSelected(null); h.render(); h.effects();
  comments.resolve({ comments: [{ id: 1, author: 'a', body: 'old', createdAt: '' }], hasMore: false }); await settle();
  expect(h.render().detail).toBeNull(); expect(h.render().comments).toEqual([]); h.dispose();
});

test('failed pages retry the same page and merge unique issues', async () => {
  const pages: number[] = []; let fail = true;
  const h = harness(api({ list: async query => {
    pages.push(query.page);
    if (query.page === 2 && fail) { fail = false; throw new Error('Rate limited'); }
    return query.page === 1 ? { ...list(1), hasMore: true, total: 2 }
      : { ...list(2), counts: null, issues: [...list(1).issues, ...list(2).issues] };
  } }));
  h.render(); h.effects(); await settle();
  await h.render().loadMore(); expect(h.render().error).toBe('Rate limited');
  await h.render().loadMore(); expect(pages).toEqual([1, 2, 2]);
  expect(h.render().list?.issues.map(item => item.number)).toEqual([1, 2]);
  expect(h.render().list?.counts).toEqual({ open: 1, closed: 2, all: 3 });
  expect(h.render().error).toBeNull(); h.dispose();
});

test('filters and refresh invalidate pending lists; unavailable bridges report an error', async () => {
  const pending = createDeferred<GitHubIssueList>(); let calls = 0;
  const h = harness(api({ list: async () => ++calls === 1 ? pending.promise : list(calls) }));
  h.render(); h.effects(); h.render('', 'closed'); h.effects(); await settle();
  h.render('', 'closed', 1); h.effects(); await settle(); pending.reject(new Error('Old failure')); await settle();
  expect(h.render('', 'closed', 1).list?.issues[0]?.number).toBe(3);
  expect(h.render('', 'closed', 1).error).toBeNull(); h.dispose();
  const missing = harness(undefined); missing.render(); missing.effects(); expect(missing.render().error).toContain('unavailable'); missing.dispose();
});

test('comment failures retry without discarding a successful issue description', async () => {
  let calls = 0;
  const h = harness(api({ read: async () => ({ ...issue, commentCount: 1 }), comments: async () => {
    if (++calls === 1) throw new Error('Comment request failed');
    return { comments: [{ id: 1, author: 'a', body: 'reply', createdAt: '' }], hasMore: false };
  } }));
  h.render(); h.effects(); await settle(); h.render().setSelected(1); h.render(); h.effects(); await settle();
  expect(h.render().detail?.body).toBe('First body'); expect(h.render().commentsError).toBe('Comment request failed');
  await h.render().loadComments(); expect(h.render().comments[0]?.body).toBe('reply'); expect(h.render().commentsError).toBeNull(); h.dispose();
});

test('state tabs retain known counts while loading, but new searches and refreshes hide stale counts', async () => {
  const pending = createDeferred<GitHubIssueList>();
  const h = harness(api({ list: query => query.state === 'open' ? Promise.resolve(list(1)) : pending.promise }));
  h.render(); h.effects(); await settle();
  expect(h.render().counts).toEqual({ open: 1, closed: 2, all: 3 });
  h.render('', 'closed'); h.effects();
  expect(h.render('', 'closed').counts).toEqual({ open: 1, closed: 2, all: 3 });
  expect(h.render('new', 'closed').counts).toBeNull(); h.effects();
  expect(h.render('', 'closed', 1).counts).toBeNull(); h.effects();
  pending.resolve({ ...list(0), counts: { open: 0, closed: 0, all: 0 } }); await settle();
  expect(h.render('', 'closed', 1).counts).toEqual({ open: 0, closed: 0, all: 0 }); h.dispose();
});

test('visited tabs, including empty results, render from cache before effects without another request', async () => {
  const calls: string[] = [];
  const h = harness(api({ list: async query => {
    calls.push(query.state);
    return query.state === 'open' ? { ...list(0), issues: [], total: 0 } : list(2);
  } }));
  h.render(); h.effects(); await settle();
  h.render('', 'closed'); h.effects(); await settle();
  const restored = h.render();
  expect(restored.list?.issues).toEqual([]); expect(restored.loading).toBe(false);
  h.effects(); await settle();
  expect(h.render('', 'closed').list?.issues[0]?.number).toBe(2);
  expect(h.render('', 'closed').loading).toBe(false); h.effects();
  expect(calls).toEqual(['open', 'closed']); h.dispose();
});

test('cached lists retain loaded pages and resume pagination after switching tabs', async () => {
  const calls: string[] = [];
  const h = harness(api({ list: async query => {
    calls.push(`${query.state}:${query.page}`);
    return { ...list(query.page), hasMore: query.page < 3, total: 3 };
  } }));
  h.render(); h.effects(); await settle(); await h.render().loadMore();
  h.render('', 'closed'); h.effects(); await settle();
  expect(h.render().list?.issues.map(item => item.number)).toEqual([1, 2]); h.effects();
  await h.render().loadMore();
  expect(h.render().list?.issues.map(item => item.number)).toEqual([1, 2, 3]);
  expect(calls).toEqual(['open:1', 'open:2', 'closed:1', 'open:3']); h.dispose();
});

test('search caches are isolated and refresh invalidates every tab and old in-flight responses', async () => {
  const stale = createDeferred<GitHubIssueList>();
  const calls: string[] = [];
  const h = harness(api({ list: query => {
    calls.push(`${query.search}:${query.state}`);
    if (query.search === 'pending') return stale.promise;
    return Promise.resolve(list(query.search === 'second' ? 2 : calls.length));
  } }));
  h.render('first'); h.effects(); await settle();
  h.render('second'); h.effects(); await settle();
  expect(h.render('first').list?.issues[0]?.number).toBe(1); h.effects();
  h.render('pending'); h.effects();
  expect(h.render('first', 'open', 1).list).toBeNull(); h.effects(); await settle();
  stale.resolve(list(99)); await settle();
  expect(h.render('first', 'open', 1).list?.issues[0]?.number).toBe(4);
  expect(h.render('second', 'open', 1).list).toBeNull(); h.effects(); await settle();
  expect(calls).toEqual(['first:open', 'second:open', 'pending:open', 'first:open', 'second:open']); h.dispose();
});

test('failed first loads are not cached and another hook cannot read this workspace cache', async () => {
  let calls = 0;
  const sharedApi = api({ list: async () => {
    if (++calls === 1) throw new Error('Temporary failure');
    return list(calls);
  } });
  const h = harness(sharedApi);
  h.render(); h.effects(); await settle(); expect(h.render().error).toBe('Temporary failure');
  h.render('', 'closed'); h.effects(); await settle();
  expect(h.render().list).toBeNull(); h.effects(); await settle();
  expect(h.render().list?.issues[0]?.number).toBe(3);
  const other = harness(sharedApi); expect(other.render().list).toBeNull(); other.effects(); await settle();
  expect(calls).toBe(4); h.dispose(); other.dispose();
});

test('query cache evicts old entries to keep long search sessions bounded', async () => {
  let calls = 0;
  const h = harness(api({ list: async () => list(++calls) }));
  for (let index = 0; index < 31; index++) { h.render(String(index)); h.effects(); await settle(); }
  expect(h.render('30').list?.issues[0]?.number).toBe(31);
  expect(h.render('0').list).toBeNull(); h.effects(); await settle();
  expect(calls).toBe(32); h.dispose();
});

function commentPage(number: number, page: number, hasMore = false): GitHubIssueComments {
  return { comments: [{ id: number * 100 + page, author: 'a', body: `Issue ${number}, page ${page}`, createdAt: '' }], hasMore };
}

test('reselecting an issue instantly restores its body and loaded comments without requests', async () => {
  const reads: number[] = []; const pages: string[] = [];
  const h = harness(api({ read: async number => { reads.push(number); return { ...issue, number, commentCount: 3 }; },
    comments: async (number, page) => { pages.push(`${number}:${page}`); return commentPage(number, page, page < 3); } }));
  h.render(); h.effects(); await settle();
  h.render().setSelected(1); h.render(); h.effects(); await settle(); await h.render().loadComments();
  h.render().setSelected(2); h.render(); h.effects(); await settle();
  h.render().setSelected(1);
  const restored = h.render();
  expect(restored.detail?.number).toBe(1); expect(restored.detailLoading).toBe(false);
  expect(restored.comments.map(item => item.id)).toEqual([101, 102]); expect(restored.commentPage).toBe(2);
  h.effects(); await settle(); expect(reads).toEqual([1, 2]); expect(pages).toEqual(['1:1', '1:2', '2:1']);
  await h.render().loadComments(); expect(pages.at(-1)).toBe('1:3'); expect(h.render().commentsMore).toBe(false); h.dispose();
});

test('issues without comments cache the empty conversation and never request comments', async () => {
  let reads = 0; let comments = 0;
  const h = harness(api({ read: async number => { reads++; return { ...issue, number }; },
    comments: async () => { comments++; return { comments: [], hasMore: false }; } }));
  h.render(); h.effects(); await settle();
  for (const number of [1, 2, 1]) { h.render().setSelected(number); h.render(); h.effects(); await settle(); }
  expect(reads).toBe(2); expect(comments).toBe(0); expect(h.render().comments).toEqual([]); h.dispose();
});

test('a failed comment page remains retryable after restoring a cached issue', async () => {
  let reads = 0; let fail = true; const pages: number[] = [];
  const h = harness(api({ read: async number => { reads++; return { ...issue, number, commentCount: number === 1 ? 2 : 0 }; },
    comments: async (number, page) => {
      pages.push(page);
      if (page === 2 && fail) { fail = false; throw new Error('Retry page two'); }
      return commentPage(number, page, page < 2);
    } }));
  h.render(); h.effects(); await settle();
  h.render().setSelected(1); h.render(); h.effects(); await settle(); await h.render().loadComments();
  h.render().setSelected(2); h.render(); h.effects(); await settle();
  h.render().setSelected(1); expect(h.render().commentsError).toBe('Retry page two'); h.effects();
  expect(h.render().comments.map(item => item.id)).toEqual([101]); await h.render().loadComments();
  expect(pages).toEqual([1, 2, 2]); expect(reads).toBe(2); expect(h.render().commentsError).toBeNull(); h.dispose();
});

test('refresh clears details and pending comments cannot repopulate the old cache', async () => {
  const old = createDeferred<GitHubIssueComments>(); let reads = 0; let calls = 0;
  const sharedApi = api({ read: async number => { reads++; return { ...issue, number, commentCount: 1 }; },
    comments: () => ++calls === 1 ? old.promise : Promise.resolve(commentPage(1, 2)) });
  const h = harness(sharedApi);
  h.render(); h.effects(); await settle(); h.render().setSelected(1); h.render(); h.effects(); await settle();
  expect(h.render('', 'open', 1).detail).toBeNull(); h.effects(); await settle(); h.render('', 'open', 1); h.effects();
  old.resolve(commentPage(1, 1)); await settle();
  h.render('', 'open', 1).setSelected(1); expect(h.render('', 'open', 1).detail).toBeNull(); h.effects(); await settle();
  expect(reads).toBe(2); expect(h.render('', 'open', 1).comments.map(item => item.id)).toEqual([102]);
  h.dispose();
  const next = harness(sharedApi); next.render(); next.effects(); await settle();
  next.render().setSelected(1); expect(next.render().detail).toBeNull(); next.effects(); await settle(); expect(reads).toBe(3); next.dispose();
});

test('failed descriptions are retried on reselection and detail cache evicts beyond thirty issues', async () => {
  let reads = 0;
  const h = harness(api({ read: async number => {
    reads++;
    if (reads === 1) throw new Error('Description failed');
    return { ...issue, number };
  } }));
  h.render(); h.effects(); await settle();
  for (const number of [1, 2, 1]) { h.render().setSelected(number); h.render(); h.effects(); await settle(); }
  expect(reads).toBe(3); expect(h.render().detail?.number).toBe(1);
  for (let number = 3; number <= 32; number++) { h.render().setSelected(number); h.render(); h.effects(); await settle(); }
  h.render().setSelected(1); expect(h.render().detail).toBeNull(); h.effects(); await settle(); expect(reads).toBe(34); h.dispose();
});
