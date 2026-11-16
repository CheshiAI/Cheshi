import { expect, test } from 'bun:test';
import { ChatsChanges } from '../lib/agent-chats/changes.mts';
import { createChatsSnapshotStore } from '../frontend/src/features/agent-chats/useChatsSnapshot';
import { parseChatsUpdate, type ChatsSnapshot, type ChatsUpdate } from '../shared/agent-chats';
import { createEventQueue } from '../lib/agent-orchestration/event-queue.mts';

const snapshot = (): ChatsSnapshot => ({ rooms: [{ id: 'room', workspace: '/project', name: 'Login', engineId: 'docker:test',
  defaultAgentId: 'dev', members: [{ id: 'dev', name: 'Dev', accountId: 'account' }], createdAt: 'now' }], messages: [
  { id: 'one', roomId: 'room', threadId: null, sender: 'user', recipient: 'dev', kind: 'message', text: 'Build login', createdAt: 'now' },
  { id: 'two', roomId: 'room', threadId: null, sender: 'dev', recipient: null, kind: 'message', text: 'Working', createdAt: 'now' },
] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('workspace events contain only changed records, ignore identical data and stop on unsubscribe', async () => {
  const states = new Map([['/project', snapshot()], ['/other', { rooms: [], messages: [] } satisfies ChatsSnapshot]]);
  const changes = new ChatsChanges(workspace => structuredClone(states.get(workspace)!));
  const updates: ChatsUpdate[] = [], other: ChatsUpdate[] = [];
  const unsubscribe = changes.subscribe('/project', event => updates.push(parseChatsUpdate(event)));
  changes.subscribe('/other', event => other.push(event));
  changes.snapshot('/project'); changes.snapshot('/other'); changes.publish(); expect(updates).toHaveLength(0);
  states.get('/project')!.messages[1]!.text = 'Done'; changes.publish();
  expect(updates).toHaveLength(1); expect(updates[0]!.messages.map(m => m.id)).toEqual(['two']);
  expect(updates[0]!.rooms).toEqual([]); expect(other).toEqual([]);
  changes.publish(); expect(updates).toHaveLength(1);
  states.get('/project')!.messages.pop(); changes.publish(); expect(updates[1]!.removedMessageIds).toEqual(['two']);
  unsubscribe(); states.get('/project')!.messages[0]!.text = 'Changed'; changes.publish(); expect(updates).toHaveLength(2);
  changes.dispose();
});

test('renderer applies deltas without fetching and preserves unchanged records; a gap or host restart resynchronizes', async () => {
  let state = snapshot(), reads = 0;
  const changes = new ChatsChanges(() => structuredClone(state));
  let source = changes;
  const store = createChatsSnapshotStore({ request: async () => { reads++; return source.snapshot('/project'); } });
  const events: ChatsUpdate[] = [];
  changes.subscribe('/project', event => events.push(event));
  await store.refresh(); const original = store.getSnapshot().snapshot;
  state = structuredClone(state); state.messages[1]!.text = 'Done'; changes.publish(); store.receive(events[0]!);
  expect(reads).toBe(1); expect(store.getSnapshot().snapshot.messages[0]).toBe(original.messages[0]);
  expect(store.getSnapshot().snapshot.rooms).toBe(original.rooms);
  const received = store.getSnapshot(); store.receive(events[0]!); expect(store.getSnapshot()).toBe(received);
  state.messages[1]!.text = 'Revision 2'; changes.publish();
  state.messages[1]!.text = 'Revision 3'; changes.publish(); store.receive(events[2]!); await store.refresh();
  expect(reads).toBe(2); expect(store.getSnapshot().snapshot.messages[1]!.text).toBe('Revision 3');
  const restarted = new ChatsChanges(() => structuredClone(state)); source = restarted; const current = restarted.snapshot('/project');
  // A new main-process epoch is an invalidation, never a patch over an old baseline.
  store.receive({ cursor: current.cursor!, rooms: [], messages: [], removedMessageIds: [], removedRoomIds: [] });
  await store.refresh(); expect(reads).toBe(3); expect(store.getSnapshot().snapshot.cursor?.epoch).toBe(current.cursor!.epoch);
  changes.dispose(); restarted.dispose();
});

test('event during initial read and sequence gap during mutation are repaired without losing acknowledged data', async () => {
  const pending = deferred<ChatsSnapshot>(), saving = deferred<ChatsSnapshot>(); let reads = 0;
  const state = { ...snapshot(), cursor: { epoch: 'epoch', sequence: 2 } };
  const store = createChatsSnapshotStore({ request: async request => request.action !== 'list' ? saving.promise : ++reads === 1 ? pending.promise : state });
  const first = store.refresh(); await Promise.resolve();
  store.receive({ cursor: state.cursor, rooms: [], messages: [], removedRoomIds: [], removedMessageIds: [] });
  pending.resolve({ ...snapshot(), cursor: { epoch: 'epoch', sequence: 0 } }); await first; await store.refresh();
  expect(store.getSnapshot().snapshot.cursor?.sequence).toBe(2);
  const mutation = store.request({ action: 'invite', roomId: 'room', members: ['dev'], defaultAgentId: 'dev' });
  state.cursor = { epoch: 'epoch', sequence: 4 };
  store.receive({ cursor: state.cursor, rooms: [], messages: [], removedRoomIds: [], removedMessageIds: [] });
  saving.resolve({ ...snapshot(), cursor: { epoch: 'epoch', sequence: 3 } }); await mutation; await store.refresh();
  expect(store.getSnapshot().snapshot.cursor?.sequence).toBe(4);
});

test('event queue coalesces bursts and drains events arriving during work without a timer', async () => {
  const gate = deferred<void>(); const calls: string[] = [];
  const queue = createEventQueue<string>(async key => { calls.push(key); if (calls.length === 1) await gate.promise; }, () => {});
  queue.notify('dev'); queue.notify('dev'); queue.start(); await Promise.resolve();
  queue.notify('dev'); queue.notify('dev'); queue.notify('planner'); gate.resolve(); await queue.settled();
  expect(calls).toEqual(['dev', 'dev', 'planner']);
  await queue.dispose(); queue.notify('dev'); expect(calls).toHaveLength(3);
});
