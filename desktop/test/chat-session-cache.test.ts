import { expect, test } from 'bun:test';
import { CHAT_SESSION_CACHE_TTL_MS, createChatSessionCache } from '../frontend/src/features/chat/chatSessionCache';
import type { ChatSession } from '../frontend/src/features/chat/model';

const session = (id = 'one', title = 'Conversation'): ChatSession => ({
  id, title, preview: '', createdAt: 1, updatedAt: 1, status: 'idle',
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('retains the loaded list after the last pane unsubscribes and skips another request on replacement', async () => {
  const cache = createChatSessionCache();
  let calls = 0;
  const load = async () => { calls += 1; return [session()]; };
  const unsubscribe = cache.subscribe(() => {});
  await cache.refresh(load);
  const snapshot = cache.getSnapshot();
  unsubscribe();
  const unsubscribeReplacement = cache.subscribe(() => {});
  expect(cache.getSnapshot()).toBe(snapshot);
  expect(cache.getSnapshot().loading).toBe(false);
  await cache.refresh(load);
  expect(calls).toBe(1);
  unsubscribeReplacement();
});

test('caches a successfully loaded empty workspace too', async () => {
  const cache = createChatSessionCache();
  let calls = 0;
  const load = async () => { calls += 1; return []; };
  await cache.refresh(load);
  await cache.refresh(load);
  expect(cache.getSnapshot()).toEqual({ sessions: [], loading: false, error: null });
  expect(calls).toBe(1);
});

test('coalesces requests while keeping the cached rows visible during a stale refresh', async () => {
  let now = 0;
  const cache = createChatSessionCache(() => now);
  await cache.refresh(async () => [session()]);
  now = CHAT_SESSION_CACHE_TTL_MS;
  const request = createDeferred<ChatSession[]>();
  let calls = 0;
  const load = () => { calls += 1; return request.promise; };
  const first = cache.refresh(load);
  const second = cache.refresh(load);
  expect(first).toBe(second);
  expect(cache.getSnapshot().sessions).toEqual([session()]);
  expect(cache.getSnapshot().loading).toBe(false);
  request.resolve([session('two')]);
  await first;
  expect(calls).toBe(1);
  expect(cache.getSnapshot().sessions).toEqual([session('two')]);
});

test('force refresh updates fresh data while separate workspaces stay isolated', async () => {
  const cache = createChatSessionCache();
  const other = createChatSessionCache();
  await cache.refresh(async () => [session()]);
  await cache.refresh(async () => [session('two')], true);
  expect(cache.getSnapshot().sessions).toEqual([session('two')]);
  expect(other.getSnapshot()).toEqual({ sessions: [], loading: true, error: null });
});

test('never restores a deleted session from an older or subsequent provider response', async () => {
  const cache = createChatSessionCache();
  await cache.refresh(async () => [session()]);
  const request = createDeferred<ChatSession[]>();
  let calls = 0;
  const refresh = cache.refresh(() => ++calls === 1 ? request.promise : Promise.resolve([session(), session('two')]), true);
  await Promise.resolve();
  cache.remove(['one']);
  request.resolve([session()]);
  await refresh;
  expect(cache.deletedIds.has('one')).toBe(true);
  expect(cache.getSnapshot().sessions).toEqual([session('two')]);
  cache.observe({ type: 'session-created', session: session() });
  expect(cache.getSnapshot().sessions).toEqual([session('two')]);
});

test('publishes new sessions and titles immediately and discards a response older than those events', async () => {
  const cache = createChatSessionCache();
  await cache.refresh(async () => [session()]);
  const request = createDeferred<ChatSession[]>();
  let calls = 0;
  const refresh = cache.refresh(() => ++calls === 1 ? request.promise
    : Promise.resolve([session('two'), session('one', 'Renamed')]), true);
  await Promise.resolve();
  cache.observe({ type: 'session-created', session: session('two') });
  cache.observe({ type: 'session-title', threadId: 'one', title: 'Renamed' });
  expect(cache.getSnapshot().sessions).toEqual([session('two'), session('one', 'Renamed')]);
  const observed: string[] = [];
  cache.subscribe(() => { observed.push(cache.getSnapshot().sessions.find(row => row.id === 'one')?.title ?? ''); });
  request.resolve([session()]);
  await refresh;
  expect(calls).toBe(2);
  expect(observed).not.toContain('Conversation');
});

test('a sessions-changed event invalidates a fresh cache', async () => {
  const cache = createChatSessionCache();
  await cache.refresh(async () => [session()]);
  cache.observe({ type: 'sessions-changed' });
  await cache.refresh(async () => [session('two')]);
  expect(cache.getSnapshot().sessions).toEqual([session('two')]);
});

test('a failed refresh preserves the list and permits retry', async () => {
  const cache = createChatSessionCache();
  await cache.refresh(async () => [session()]);
  await cache.refresh(async () => { throw new Error('Unavailable'); }, true);
  expect(cache.getSnapshot()).toEqual({ sessions: [session()], loading: false, error: 'Unavailable' });
  await cache.refresh(async () => [session('two')]);
  expect(cache.getSnapshot()).toEqual({ sessions: [session('two')], loading: false, error: null });
});
