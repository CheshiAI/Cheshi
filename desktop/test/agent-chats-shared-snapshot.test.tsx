import { expect, test } from 'bun:test';
import { act, StrictMode } from 'react';
import { useChatsSnapshot } from '../frontend/src/features/agent-chats/useChatsSnapshot';
import { useHomieParticipants } from '../frontend/src/features/agents/useHomieParticipants';
import type { AgentChatsApi, ChatsRequest, ChatsSnapshot, ChatsUpdate } from '../shared/agent-chats';
import { specialistAgent, registryDeferred } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';

const agent = { ...specialistAgent(), id: 'dev', accountId: 'account', name: 'Development',
  assignments: [{ workspaceRoot: '/project', instructions: '' }] };
const reviewer = { ...agent, id: 'review', name: 'Review' };
const agents = [agent, reviewer];
function saved(name = 'Work'): ChatsSnapshot {
  return { cursor: { epoch: 'test', sequence: 0 }, rooms: [{ id: 'room', name, workspace: '/project',
    engineId: 'docker:test', defaultAgentId: agent.id, members: [agent, reviewer], createdAt: '2026-10-06T00:00:00Z' }], messages: [] };
}
function Consumer({ api, id = 'worker', active = true }: { api: AgentChatsApi; id?: string; active?: boolean }) {
  const data = useChatsSnapshot(api, active);
  return <output aria-label={id}>{data.loaded ? `${data.snapshot.rooms[0]?.name}:${data.snapshot.rooms[0]?.members.length}` : 'Loading'}</output>;
}
function Participants({ api }: { api: AgentChatsApi }) {
  const data = useHomieParticipants('room', agents, '/project', api);
  return <section>
    <output aria-label="participants">{data.loading ? 'Loading' : `${data.room?.name}:${data.members.length}`}</output>
    <button onClick={() => data.toggle(reviewer.id, false)}>Remove reviewer</button>
    <button disabled={!data.canSave} onClick={() => { void data.save(); }}>Save participants</button>
  </section>;
}
function fixture() {
  let snapshot = saved(), subscriptions = 0, disconnections = 0;
  const listeners = new Set<(update: ChatsUpdate) => void>();
  const requests: ChatsRequest[] = [];
  const api: AgentChatsApi = {
    request: async request => {
      requests.push(request);
      if (request.action === 'participants') snapshot = { ...snapshot,
        cursor: { epoch: 'test', sequence: snapshot.cursor!.sequence + 1 },
        rooms: snapshot.rooms.map(room => ({ ...room, members: room.members.filter(member => request.members.includes(member.id)),
          defaultAgentId: request.defaultAgentId })) };
      return snapshot;
    },
    onDidChange: listener => {
      subscriptions++; listeners.add(listener);
      return () => { disconnections++; listeners.delete(listener); };
    },
  };
  return { api, requests, listeners, connections: () => ({ subscriptions, disconnections }),
    rename(name: string) {
      snapshot = { ...snapshot, cursor: { epoch: 'test', sequence: snapshot.cursor!.sequence + 1 },
        rooms: snapshot.rooms.map(room => ({ ...room, name })) };
      for (const listener of listeners) listener({ ...snapshot, cursor: snapshot.cursor!, removedRoomIds: [], removedMessageIds: [] });
    } };
}
const output = (label: string) => document.querySelector(`[aria-label="${label}"]`)?.textContent;

test('Homies reuses the loaded Worker snapshot and event subscription, and saves update both consumers', async () => {
  const f = fixture();
  await withDOM(async ui => {
    const render = (panel: boolean, worker = true) => ui.render(<>
      {worker && <Consumer api={f.api} />}{panel && <Participants api={f.api} />}
    </>);
    await render(false);
    await render(true);
    expect(f.requests).toEqual([{ action: 'list' }]);
    expect(f.connections()).toEqual({ subscriptions: 1, disconnections: 0 });
    expect(output('participants')).toBe('Work:2');
    await act(async () => f.rename('Renamed'));
    expect(output('worker')).toBe('Renamed:2');
    expect(output('participants')).toBe('Renamed:2');
    await ui.click('Remove reviewer');
    await ui.click('Save participants');
    expect(output('worker')).toBe('Renamed:1');
    expect(output('participants')).toBe('Renamed:1');
    expect(f.requests.filter(request => request.action === 'list')).toHaveLength(1);
    await render(false);
    expect(f.listeners.size).toBe(1);
    await render(true);
    expect(output('participants')).toBe('Renamed:1');
    expect(f.requests.filter(request => request.action === 'list')).toHaveLength(1);
    await render(false, false);
    expect(f.connections()).toEqual({ subscriptions: 1, disconnections: 1 });
    const beforeFocus = f.requests.length;
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    expect(f.requests).toHaveLength(beforeFocus);
    f.rename('Changed while disconnected');
    await render(true);
    expect(output('worker')).toBe('Changed while disconnected:1');
    expect(f.requests.filter(request => request.action === 'list')).toHaveLength(2);
  });
  expect(f.listeners.size).toBe(0);
});

test('opening Homies during initial loading shares the pending read', async () => {
  const f = fixture(), gate = registryDeferred<ChatsSnapshot>();
  const request = f.api.request;
  f.api.request = async input => { await request(input); return gate.promise; };
  await withDOM(async ui => {
    await ui.render(<Consumer api={f.api} />);
    await ui.render(<><Consumer api={f.api} /><Participants api={f.api} /></>);
    expect(output('participants')).toBe('Loading');
    expect(f.requests).toHaveLength(1);
    expect(f.listeners.size).toBe(1);
    await act(async () => gate.resolve(saved()));
    expect(output('worker')).toBe('Work:2');
    expect(output('participants')).toBe('Work:2');
    expect(f.requests).toHaveLength(1);
  });
});

test('workspace API objects stay isolated and an inactive consumer keeps updates after the panel closes', async () => {
  const first = fixture(), second = fixture();
  second.rename('Other workspace');
  await withDOM(async ui => {
    const render = (panel: boolean) => ui.render(<>
      <Consumer api={first.api} active={false} />
      <Consumer api={second.api} id="other" />
      {panel && <Participants api={first.api} />}
    </>);
    await render(true);
    expect(output('worker')).toBe('Work:2');
    expect(output('other')).toBe('Other workspace:2');
    await render(false);
    await act(async () => first.rename('Background update'));
    expect(output('worker')).toBe('Background update:2');
    const beforeFocus = first.requests.length;
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    expect(first.requests).toHaveLength(beforeFocus);
    expect(second.requests).toHaveLength(2);
  });
  expect(first.listeners.size).toBe(0);
  expect(second.listeners.size).toBe(0);
});

test('StrictMode reconnects safely and leaves one subscription until final unmount', async () => {
  const f = fixture();
  await withDOM(async ui => {
    await ui.render(<StrictMode><Consumer api={f.api} /><Participants api={f.api} /></StrictMode>);
    expect(f.listeners.size).toBe(1);
    expect(output('worker')).toBe('Work:2');
    await act(async () => f.rename('Still connected'));
    expect(output('participants')).toBe('Still connected:2');
  });
  expect(f.listeners.size).toBe(0);
  const { subscriptions, disconnections } = f.connections();
  expect(subscriptions).toBe(disconnections);
});

test('reconnecting during an old pending read refreshes changes missed while disconnected', async () => {
  const f = fixture(), stale = registryDeferred<ChatsSnapshot>();
  const request = f.api.request;
  let reads = 0;
  f.api.request = async input => {
    const result = await request(input);
    return ++reads === 1 ? stale.promise : result;
  };
  await withDOM(async ui => {
    await ui.render(<Consumer api={f.api} />);
    await ui.render(null);
    expect(f.listeners.size).toBe(0);
    f.rename('Missed while disconnected');
    await ui.render(<><Consumer api={f.api} /><Participants api={f.api} /></>);
    await act(async () => stale.resolve(saved('Stale response')));
    expect(output('worker')).toBe('Missed while disconnected:2');
    expect(output('participants')).toBe('Missed while disconnected:2');
    expect(reads).toBe(2);
    expect(f.listeners.size).toBe(1);
  });
});
