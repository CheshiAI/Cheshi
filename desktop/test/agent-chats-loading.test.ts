import { expect, test } from 'bun:test';
import { createChatsSnapshotStore } from '../frontend/src/features/agent-chats/useChatsSnapshot';
import type { ChatsSnapshot } from '../shared/agent-chats';

function createDeferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const snapshot = (name = 'Room'): ChatsSnapshot => ({ rooms: [{ id: 'room', workspace: '/project', name,
  engineId: 'docker:test', defaultAgentId: 'dev', members: [{ id: 'dev', accountId: 'account', name: 'Dev' }], createdAt: 'now' }], messages: [] });

test('initial loading, request coalescing and successful empty data are distinct', async () => {
  const load = createDeferred<ChatsSnapshot>(); let calls = 0;
  const store = createChatsSnapshotStore({ request: async () => { calls++; return load.promise; } });
  expect(store.getSnapshot()).toMatchObject({ loaded: false, phase: 'loading' });
  const first = store.refresh(false), duplicate = store.refresh(false);
  expect(first).toBe(duplicate); await Promise.resolve(); expect(calls).toBe(1);
  load.resolve({ rooms: [], messages: [] }); await first;
  expect(store.getSnapshot()).toMatchObject({ loaded: true, phase: 'ready', refreshing: false, error: null });
  await store.refresh(false); expect(calls).toBe(1);
});

test('a failed first read stays unavailable until a successful retry', async () => {
  let fail = true;
  const store = createChatsSnapshotStore({ request: async () => { if (fail) throw new Error('Offline'); return snapshot(); } });
  await store.refresh(); expect(store.getSnapshot()).toMatchObject({ loaded: false, phase: 'error', error: 'Offline' });
  fail = false; await store.refresh();
  expect(store.getSnapshot()).toMatchObject({ loaded: true, phase: 'ready', error: null });
  expect(store.getSnapshot().snapshot.rooms[0]?.name).toBe('Room');
});

test('background refresh and its failure retain the acknowledged list', async () => {
  const background = createDeferred<ChatsSnapshot>(); let calls = 0;
  const store = createChatsSnapshotStore({ request: async () => ++calls === 1 ? snapshot() : background.promise });
  await store.refresh(); const acknowledged = store.getSnapshot().snapshot;
  const refresh = store.refresh();
  expect(store.getSnapshot().snapshot).toBe(acknowledged);
  expect(store.getSnapshot()).toMatchObject({ loaded: true, phase: 'ready', refreshing: true });
  background.reject(new Error('Connection failed')); await refresh;
  expect(store.getSnapshot().snapshot).toBe(acknowledged);
  expect(store.getSnapshot()).toMatchObject({ phase: 'error', loaded: true, refreshing: false });
});

test('an older list cannot overwrite a newly acknowledged mutation', async () => {
  const stale = createDeferred<ChatsSnapshot>(), latest = createDeferred<ChatsSnapshot>(); let reads = 0;
  const store = createChatsSnapshotStore({ request: async request => request.action === 'list'
    ? ++reads === 1 ? stale.promise : latest.promise : snapshot('New room') });
  const read = store.refresh(); await Promise.resolve();
  await store.request({ action: 'create', id: 'room', name: 'New room', engineId: 'docker:test', members: ['dev'], defaultAgentId: 'dev' });
  stale.resolve(snapshot('Old room')); await read;
  expect(store.getSnapshot().snapshot.rooms[0]?.name).toBe('New room');
  latest.resolve(snapshot('New room')); await store.refresh();
  expect(store.getSnapshot().snapshot.rooms[0]?.name).toBe('New room');
});

test('missing desktop API is an error rather than successful empty data', async () => {
  const store = createChatsSnapshotStore(); await store.refresh();
  expect(store.getSnapshot()).toMatchObject({ loaded: false, phase: 'error', refreshing: false });
  expect(store.getSnapshot().error).toContain('Restart');
});
